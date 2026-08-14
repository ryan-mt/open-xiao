//! Pre-mutation file snapshots so Review can undo agent edits for the current session.

use crate::paths::{is_path_within_root, path_compare_key, strip_verbatim_prefix};
use cap_fs_ext::{FollowSymlinks, MetadataExt as CapMetadataExt, OpenOptionsFollowExt};
use cap_std::ambient_authority;
use cap_std::fs::{Dir, File as CapFile, Metadata as CapMetadata, OpenOptions};
use serde::Serialize;
use std::collections::{hash_map::RandomState, HashMap};
use std::fs;
use std::hash::BuildHasher;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

const MAX_SNAPSHOT_BYTES: usize = 2_000_000;
const MAX_ENTRIES: usize = 400;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub tool_id: String,
    pub stream_id: String,
    pub path: String,
    pub display_path: String,
    pub kind: String,
    pub created_at: u64,
}

#[derive(Debug, Clone)]
struct SnapshotEntry {
    tool_id: String,
    stream_id: String,
    /// Absolute normalized path on disk.
    abs_path: PathBuf,
    display_path: String,
    /// Previous file bytes. `None` means the file did not exist (created by agent).
    /// For deletes, holds the content that was removed.
    previous: Option<Vec<u8>>,
    kind: SnapshotKind,
    created_at: u64,
    /// Filesystem scope captured before the mutation.
    scope: SnapshotScope,
    /// Content fingerprint and existence observed after the mutation landed.
    /// Restore compares against this instead of filesystem timestamps.
    post_state: Option<Result<DiskState, String>>,
    /// Stable identity of the immediate parent observed after the mutation.
    post_parent: Option<Result<DirectoryAnchor, String>>,
}

#[derive(Debug, Clone)]
enum SnapshotScope {
    Workspace { root: DirectoryAnchor },
    FullAccess { anchor: DirectoryAnchor },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DirectoryAnchor {
    canonical_path: PathBuf,
    identity: DirectoryIdentity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DirectoryIdentity {
    #[cfg(unix)]
    Unix { device: u64, inode: u64 },
    #[cfg(windows)]
    Windows { volume_serial: u32, file_index: u64 },
    #[cfg(not(any(unix, windows)))]
    Other { created_ns: u128, modified_ns: u128 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DiskState {
    Missing,
    File { len: u64, fingerprint: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SnapshotKind {
    Created,
    Modified,
    Deleted,
}

impl SnapshotKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Modified => "modified",
            Self::Deleted => "deleted",
        }
    }
}

pub struct SnapshotState {
    inner: Mutex<SnapshotInner>,
    fingerprint_builder: RandomState,
}

struct SnapshotInner {
    /// Keyed by `{stream_id}\u{1f}{tool_id}\u{1f}{path}` so one multi-file tool call (patch)
    /// can snapshot every file it touches.
    by_key: HashMap<String, SnapshotEntry>,
    /// Insertion order for eviction.
    order: Vec<String>,
    /// Tool calls whose complete pre-mutation state could not be captured.
    incomplete_batches: HashMap<String, Vec<String>>,
    /// Batch insertion order so eviction never leaves a tool call partially undoable.
    batch_order: Vec<String>,
}

/// Composite map key: stream id + tool id + path (case-insensitive path on Windows).
fn entry_key(stream_id: &str, tool_id: &str, abs_path: &Path) -> String {
    format!("{stream_id}\u{1f}{tool_id}\u{1f}{}", path_key(abs_path))
}

fn batch_key(stream_id: &str, tool_id: &str) -> String {
    format!("{stream_id}\u{1f}{tool_id}")
}

impl SnapshotState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SnapshotInner {
                by_key: HashMap::new(),
                order: Vec::new(),
                incomplete_batches: HashMap::new(),
                batch_order: Vec::new(),
            }),
            fingerprint_builder: RandomState::new(),
        }
    }

    /// Capture file state before a mutation. Safe to call even if path missing.
    pub fn capture_before_write(
        &self,
        stream_id: &str,
        tool_id: &str,
        abs_path: &Path,
        display_path: &str,
        workspace_root: &Path,
        full_access: bool,
    ) -> Result<(), String> {
        if tool_id.trim().is_empty() {
            return Ok(());
        }
        let scope = capture_scope(workspace_root, abs_path, full_access)?;
        validate_snapshot_path(abs_path, &scope, false)?;
        let existed = abs_path.is_file();
        let previous = if existed {
            // Size-check before reading so multi-GB files cannot OOM the host.
            let metadata = match fs::metadata(abs_path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    self.record_incomplete(
                        stream_id,
                        tool_id,
                        format!("{display_path}: could not inspect previous content ({error})"),
                    );
                    return Ok(());
                }
            };
            if metadata.len() > MAX_SNAPSHOT_BYTES as u64 {
                self.record_incomplete(
                    stream_id,
                    tool_id,
                    format!(
                        "{display_path}: previous content exceeds the {MAX_SNAPSHOT_BYTES}-byte undo limit"
                    ),
                );
                return Ok(());
            }
            match fs::read(abs_path) {
                Ok(bytes) => Some(bytes),
                Err(error) => {
                    self.record_incomplete(
                        stream_id,
                        tool_id,
                        format!("{display_path}: could not read previous content ({error})"),
                    );
                    return Ok(());
                }
            }
        } else {
            None
        };
        let kind = if existed {
            SnapshotKind::Modified
        } else {
            SnapshotKind::Created
        };
        self.insert(SnapshotEntry {
            tool_id: tool_id.to_string(),
            stream_id: stream_id.to_string(),
            abs_path: abs_path.to_path_buf(),
            display_path: display_path.to_string(),
            previous,
            kind,
            created_at: now_ms(),
            scope,
            post_state: None,
            post_parent: None,
        });
        Ok(())
    }

    pub fn capture_before_delete(
        &self,
        stream_id: &str,
        tool_id: &str,
        abs_path: &Path,
        display_path: &str,
        workspace_root: &Path,
        full_access: bool,
    ) -> Result<(), String> {
        if tool_id.trim().is_empty() || !abs_path.is_file() {
            return Ok(());
        }
        let scope = capture_scope(workspace_root, abs_path, full_access)?;
        validate_snapshot_path(abs_path, &scope, true)?;
        // Size-check before reading so multi-GB files cannot OOM the host.
        let oversize = fs::metadata(abs_path)
            .map(|m| m.len() > MAX_SNAPSHOT_BYTES as u64)
            .unwrap_or(true);
        if oversize {
            self.record_incomplete(
                stream_id,
                tool_id,
                format!(
                    "{display_path}: previous content is unavailable or exceeds the {MAX_SNAPSHOT_BYTES}-byte undo limit"
                ),
            );
            return Ok(());
        }
        let previous = match fs::read(abs_path) {
            Ok(bytes) => Some(bytes),
            Err(error) => {
                self.record_incomplete(
                    stream_id,
                    tool_id,
                    format!("{display_path}: could not read previous content ({error})"),
                );
                return Ok(());
            }
        };
        self.insert(SnapshotEntry {
            tool_id: tool_id.to_string(),
            stream_id: stream_id.to_string(),
            abs_path: abs_path.to_path_buf(),
            display_path: display_path.to_string(),
            previous,
            kind: SnapshotKind::Deleted,
            created_at: now_ms(),
            scope,
            post_state: None,
            post_parent: None,
        });
        Ok(())
    }

    /// Record content/existence evidence after `tool_id` landed on disk.
    /// Multi-file tools (patch) have one entry per touched path.
    pub fn mark_written(&self, stream_id: &str, tool_id: &str) {
        let mut guard = self.inner.lock().expect("snapshot lock");
        for entry in guard.by_key.values_mut() {
            if entry.stream_id == stream_id && entry.tool_id == tool_id {
                let parent = validate_snapshot_path(&entry.abs_path, &entry.scope, true)
                    .and_then(|()| immediate_parent_anchor(&entry.abs_path));
                entry.post_state = Some(match &parent {
                    Ok(_) => read_disk_state(&entry.abs_path, &self.fingerprint_builder),
                    Err(err) => Err(err.clone()),
                });
                entry.post_parent = Some(parent);
            }
        }
    }

    fn insert(&self, entry: SnapshotEntry) {
        let mut guard = self.inner.lock().expect("snapshot lock");
        let key = entry_key(&entry.stream_id, &entry.tool_id, &entry.abs_path);
        if guard.by_key.contains_key(&key) {
            return;
        }
        let batch = batch_key(&entry.stream_id, &entry.tool_id);
        if guard.incomplete_batches.contains_key(&batch) {
            return;
        }
        let batch_entries = guard
            .by_key
            .values()
            .filter(|existing| batch_key(&existing.stream_id, &existing.tool_id) == batch)
            .count();
        if batch_entries >= MAX_ENTRIES {
            remove_snapshot_batch_entries(&mut guard, &batch);
            guard.incomplete_batches.insert(
                batch.clone(),
                vec![format!(
                    "snapshot batch exceeds the {MAX_ENTRIES}-file undo limit"
                )],
            );
            if !guard.batch_order.contains(&batch) {
                guard.batch_order.push(batch);
            }
            evict_snapshot_batches(&mut guard);
            return;
        }
        guard.by_key.insert(key.clone(), entry);
        guard.order.push(key);
        if !guard.batch_order.contains(&batch) {
            guard.batch_order.push(batch);
        }
        evict_snapshot_batches(&mut guard);
    }

    fn record_incomplete(&self, stream_id: &str, tool_id: &str, reason: String) {
        let mut guard = self.inner.lock().expect("snapshot lock");
        let batch = batch_key(stream_id, tool_id);
        let reasons = guard.incomplete_batches.entry(batch.clone()).or_default();
        if !reasons.contains(&reason) {
            reasons.push(reason);
        }
        if !guard.batch_order.contains(&batch) {
            guard.batch_order.push(batch);
        }
        evict_snapshot_batches(&mut guard);
    }

    pub fn list_for_stream(&self, stream_id: &str) -> Vec<SnapshotInfo> {
        let guard = self.inner.lock().expect("snapshot lock");
        guard
            .order
            .iter()
            .filter_map(|key| guard.by_key.get(key))
            .filter(|e| e.stream_id == stream_id)
            .map(|e| SnapshotInfo {
                tool_id: e.tool_id.clone(),
                stream_id: e.stream_id.clone(),
                path: e.abs_path.to_string_lossy().into_owned(),
                display_path: e.display_path.clone(),
                kind: e.kind.as_str().into(),
                created_at: e.created_at,
            })
            .collect()
    }

    /// Restore files to the state before the earliest selected mutation per path.
    /// Successfully restored entries are removed so the undo list stays accurate.
    pub fn restore_tools(
        &self,
        stream_id: &str,
        tool_ids: &[String],
    ) -> Result<RestoreReport, String> {
        if tool_ids.is_empty() {
            return Err("No snapshot ids provided".into());
        }
        let mut guard = self.inner.lock().expect("snapshot lock");
        let selected: std::collections::HashSet<&str> =
            tool_ids.iter().map(String::as_str).collect();
        let incomplete: Vec<String> = tool_ids
            .iter()
            .filter_map(|tool_id| {
                guard
                    .incomplete_batches
                    .get(&batch_key(stream_id, tool_id))
                    .map(|reasons| format!("{tool_id}: {}", reasons.join(", ")))
            })
            .collect();
        if !incomplete.is_empty() {
            return Err(format!(
                "Undo refused because the selected snapshot batch is incomplete; no files were restored. {}",
                incomplete.join("; ")
            ));
        }
        let mut entries: Vec<SnapshotEntry> = Vec::new();
        for key in &guard.order {
            let Some(e) = guard.by_key.get(key) else {
                continue;
            };
            if e.stream_id == stream_id && selected.contains(e.tool_id.as_str()) {
                entries.push(e.clone());
            }
        }
        if entries.is_empty() {
            return Err(
                "No matching snapshots in this session (undo is available only for edits made after the app captured them)."
                    .into(),
            );
        }
        let mut group_index: HashMap<String, usize> = HashMap::new();
        let mut groups: Vec<(SnapshotEntry, SnapshotEntry)> = Vec::new();
        for entry in entries {
            let key = path_key(&entry.abs_path);
            if let Some(index) = group_index.get(&key).copied() {
                groups[index].1 = entry;
            } else {
                group_index.insert(key, groups.len());
                groups.push((entry.clone(), entry));
            }
        }
        let mut restored = Vec::new();
        let mut errors = Vec::new();
        let mut restored_path_keys = std::collections::HashSet::new();

        for (earliest, latest) in &groups {
            match restore_one(earliest, latest, &self.fingerprint_builder) {
                Ok(label) => {
                    restored.push(label);
                    restored_path_keys.insert(path_key(&earliest.abs_path));
                }
                Err(err) => errors.push(format!("{}: {err}", earliest.display_path)),
            }
        }

        // Drop every snapshot for the restored paths so the undo list stays accurate.
        guard.by_key.retain(|_, e| {
            e.stream_id != stream_id || !restored_path_keys.contains(&path_key(&e.abs_path))
        });
        let kept: std::collections::HashSet<String> = guard.by_key.keys().cloned().collect();
        guard.order.retain(|key| kept.contains(key));
        prune_snapshot_batch_order(&mut guard);

        if restored.is_empty() && !errors.is_empty() {
            return Err(errors.join("; "));
        }
        Ok(RestoreReport { restored, errors })
    }
}

fn evict_snapshot_batches(inner: &mut SnapshotInner) {
    while inner.order.len() > MAX_ENTRIES || inner.batch_order.len() > MAX_ENTRIES {
        let Some(old_batch) = inner.batch_order.first().cloned() else {
            break;
        };
        inner.batch_order.remove(0);
        remove_snapshot_batch_entries(inner, &old_batch);
        inner.incomplete_batches.remove(&old_batch);
    }
}

fn remove_snapshot_batch_entries(inner: &mut SnapshotInner, batch: &str) {
    inner
        .by_key
        .retain(|_, entry| batch_key(&entry.stream_id, &entry.tool_id) != batch);
    let kept: std::collections::HashSet<String> = inner.by_key.keys().cloned().collect();
    inner.order.retain(|key| kept.contains(key));
}

fn prune_snapshot_batch_order(inner: &mut SnapshotInner) {
    let mut kept: std::collections::HashSet<String> = inner
        .by_key
        .values()
        .map(|entry| batch_key(&entry.stream_id, &entry.tool_id))
        .collect();
    kept.extend(inner.incomplete_batches.keys().cloned());
    inner.batch_order.retain(|batch| kept.contains(batch));
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub restored: Vec<String>,
    pub errors: Vec<String>,
}

fn restore_one(
    earliest: &SnapshotEntry,
    latest: &SnapshotEntry,
    fingerprint_builder: &RandomState,
) -> Result<String, String> {
    restore_one_with_hook(earliest, latest, fingerprint_builder, || {})
}

fn restore_one_with_hook<F>(
    earliest: &SnapshotEntry,
    latest: &SnapshotEntry,
    fingerprint_builder: &RandomState,
    after_parent_open: F,
) -> Result<String, String>
where
    F: FnOnce(),
{
    validate_snapshot_path(&latest.abs_path, &latest.scope, true)
        .map_err(|err| format!("filesystem boundary changed ({err}); undo skipped"))?;
    let expected_parent = latest
        .post_parent
        .as_ref()
        .ok_or_else(|| {
            "missing post-edit parent evidence; undo skipped to protect newer work".to_string()
        })?
        .as_ref()
        .map_err(|err| {
            format!("could not record post-edit parent evidence ({err}); undo skipped")
        })?;
    let current_parent = immediate_parent_anchor(&latest.abs_path)
        .map_err(|err| format!("could not verify current parent ({err}); undo skipped"))?;
    if &current_parent != expected_parent {
        return Err(
            "parent directory was replaced; undo skipped to protect redirected paths".into(),
        );
    }

    let (parent, name) = open_restore_parent(&latest.abs_path, expected_parent)?;
    after_parent_open();

    let expected = latest
        .post_state
        .as_ref()
        .ok_or_else(|| {
            "missing post-edit evidence; undo skipped to protect newer work".to_string()
        })?
        .as_ref()
        .map_err(|err| format!("could not record post-edit evidence ({err}); undo skipped"))?;
    let mut current = open_restore_target(
        &parent,
        &name,
        earliest.kind != SnapshotKind::Created,
        fingerprint_builder,
    )
    .map_err(|err| format!("could not verify current file state ({err}); undo skipped"))?;
    let current_state = current.disk_state();
    if &current_state != expected {
        return Err(format!(
            "{} changed after the edit; undo skipped to protect newer work",
            latest.display_path
        ));
    }

    match earliest.kind {
        SnapshotKind::Created => {
            if let RestoreTarget::File { metadata, .. } = &current {
                ensure_restore_entry_matches(&parent, &name, metadata)?;
                parent
                    .remove_file(&name)
                    .map_err(|err| format!("remove created file: {err}"))?;
            }
            Ok(format!("Removed {}", earliest.display_path))
        }
        SnapshotKind::Modified | SnapshotKind::Deleted => {
            let bytes = earliest
                .previous
                .as_ref()
                .ok_or_else(|| "missing previous content".to_string())?;
            current.write_or_create(&parent, &name, bytes)?;
            Ok(format!("Restored {}", earliest.display_path))
        }
    }
}

enum RestoreTarget {
    Missing,
    File {
        file: CapFile,
        metadata: CapMetadata,
        state: DiskState,
    },
}

impl RestoreTarget {
    fn disk_state(&self) -> DiskState {
        match self {
            Self::Missing => DiskState::Missing,
            Self::File { state, .. } => state.clone(),
        }
    }

    fn write_or_create(&mut self, parent: &Dir, name: &Path, bytes: &[u8]) -> Result<(), String> {
        match self {
            Self::Missing => {
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                options.follow(FollowSymlinks::No);
                let mut file = parent
                    .open_with(name, &options)
                    .map_err(|err| format!("write: {err}"))?;
                file.write_all(bytes).map_err(|err| format!("write: {err}"))
            }
            Self::File { file, metadata, .. } => {
                ensure_restore_entry_matches(parent, name, metadata)?;
                file.seek(SeekFrom::Start(0))
                    .map_err(|err| format!("seek: {err}"))?;
                file.set_len(0).map_err(|err| format!("truncate: {err}"))?;
                file.write_all(bytes).map_err(|err| format!("write: {err}"))
            }
        }
    }
}

fn open_restore_parent(path: &Path, expected: &DirectoryAnchor) -> Result<(Dir, PathBuf), String> {
    let parent_path = path
        .parent()
        .ok_or_else(|| "snapshot target has no parent directory".to_string())?;
    let name = path
        .file_name()
        .map(PathBuf::from)
        .ok_or_else(|| "snapshot target has no file name".to_string())?;
    let parent = Dir::open_ambient_dir(parent_path, ambient_authority())
        .map_err(|err| format!("could not retain restore parent ({err}); undo skipped"))?;
    let metadata = parent.dir_metadata().map_err(|err| {
        format!("could not inspect retained restore parent ({err}); undo skipped")
    })?;
    if !cap_metadata_matches_anchor(&metadata, expected) {
        return Err("parent directory changed while it was opened; undo skipped".into());
    }
    Ok((parent, name))
}

fn open_restore_target(
    parent: &Dir,
    name: &Path,
    writable: bool,
    fingerprint_builder: &RandomState,
) -> Result<RestoreTarget, String> {
    let before = match parent.symlink_metadata(name) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RestoreTarget::Missing)
        }
        Err(err) => return Err(format!("metadata: {err}")),
    };
    if before.is_symlink() {
        return Err("path is a symbolic link".into());
    }
    if !before.is_file() {
        return Err("path is not a regular file".into());
    }
    if before.len() > MAX_SNAPSHOT_BYTES as u64 {
        return Err(format!(
            "file is too large to verify ({} bytes)",
            before.len()
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true).write(writable);
    options.follow(FollowSymlinks::No);
    let mut file = parent
        .open_with(name, &options)
        .map_err(|err| format!("open: {err}"))?;
    let metadata = file.metadata().map_err(|err| format!("metadata: {err}"))?;
    if !same_cap_metadata(&before, &metadata) {
        return Err("file changed while it was opened".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|err| format!("read: {err}"))?;
    let state = DiskState::File {
        len: metadata.len(),
        fingerprint: fingerprint_builder.hash_one(&bytes),
    };
    Ok(RestoreTarget::File {
        file,
        metadata,
        state,
    })
}

fn ensure_restore_entry_matches(
    parent: &Dir,
    name: &Path,
    opened: &CapMetadata,
) -> Result<(), String> {
    let current = parent
        .symlink_metadata(name)
        .map_err(|err| format!("recheck restore target: {err}"))?;
    if current.is_symlink() || !current.is_file() || !same_cap_metadata(&current, opened) {
        return Err("restore target changed after validation".into());
    }
    Ok(())
}

fn same_cap_metadata(left: &CapMetadata, right: &CapMetadata) -> bool {
    left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(unix)]
fn cap_metadata_matches_anchor(metadata: &CapMetadata, anchor: &DirectoryAnchor) -> bool {
    matches!(
        anchor.identity,
        DirectoryIdentity::Unix { device, inode }
            if metadata.dev() == device && metadata.ino() == inode
    )
}

#[cfg(windows)]
fn cap_metadata_matches_anchor(metadata: &CapMetadata, anchor: &DirectoryAnchor) -> bool {
    matches!(
        anchor.identity,
        DirectoryIdentity::Windows {
            volume_serial,
            file_index
        } if metadata.dev() == u64::from(volume_serial) && metadata.ino() == file_index
    )
}

#[cfg(not(any(unix, windows)))]
fn cap_metadata_matches_anchor(_metadata: &CapMetadata, _anchor: &DirectoryAnchor) -> bool {
    false
}

fn capture_scope(
    workspace_root: &Path,
    path: &Path,
    full_access: bool,
) -> Result<SnapshotScope, String> {
    if full_access {
        let parent = path
            .parent()
            .ok_or_else(|| "snapshot target has no parent directory".to_string())?;
        let existing_parent = nearest_existing_directory(parent)?;
        Ok(SnapshotScope::FullAccess {
            anchor: directory_anchor(&existing_parent)?,
        })
    } else {
        Ok(SnapshotScope::Workspace {
            root: directory_anchor(workspace_root)?,
        })
    }
}

fn validate_snapshot_path(
    path: &Path,
    scope: &SnapshotScope,
    require_parent: bool,
) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err("final path component is a symbolic link or junction".into())
        }
        Ok(_) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => return Err(format!("inspect target metadata: {err}")),
    }

    let base = match scope {
        SnapshotScope::Workspace { root } => root,
        SnapshotScope::FullAccess { anchor } => anchor,
    };
    validate_directory_anchor(base)?;
    if !is_path_within_root(&base.canonical_path, path) {
        return Err("path is outside its original filesystem scope".into());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "snapshot target has no parent directory".to_string())?;
    let existing_parent = if require_parent {
        let metadata = fs::symlink_metadata(parent)
            .map_err(|err| format!("parent directory is missing or inaccessible: {err}"))?;
        if metadata.file_type().is_symlink() {
            return Err("parent directory is a symbolic link or junction".into());
        }
        if !metadata.is_dir() {
            return Err("parent path is not a directory".into());
        }
        parent.to_path_buf()
    } else {
        nearest_existing_directory(parent)?
    };

    reject_redirected_ancestors(&base.canonical_path, &existing_parent)?;
    let canonical_parent = strip_verbatim_prefix(
        fs::canonicalize(&existing_parent)
            .map_err(|err| format!("canonicalize existing parent: {err}"))?,
    );
    if !is_path_within_root(&base.canonical_path, &canonical_parent) {
        return Err("existing parent resolves outside its original filesystem scope".into());
    }
    Ok(())
}

fn nearest_existing_directory(start: &Path) -> Result<PathBuf, String> {
    let mut cursor = start.to_path_buf();
    loop {
        match fs::symlink_metadata(&cursor) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "ancestor is a symbolic link or junction: {}",
                        cursor.display()
                    ));
                }
                if !metadata.is_dir() {
                    return Err(format!("ancestor is not a directory: {}", cursor.display()));
                }
                return Ok(cursor);
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("inspect ancestor {}: {err}", cursor.display())),
        }
        if !cursor.pop() {
            return Err("no existing parent directory found".into());
        }
    }
}

fn reject_redirected_ancestors(base: &Path, existing_parent: &Path) -> Result<(), String> {
    let relative = match existing_parent.strip_prefix(base) {
        Ok(relative) => relative.to_path_buf(),
        Err(_) if cfg!(windows) => {
            let base_key = path_compare_key(base);
            let child_key = path_compare_key(existing_parent);
            if child_key == base_key {
                PathBuf::new()
            } else {
                let prefix = format!("{}/", base_key.trim_end_matches('/'));
                let suffix = child_key.strip_prefix(&prefix).ok_or_else(|| {
                    "existing parent is outside its original filesystem scope".to_string()
                })?;
                PathBuf::from(suffix)
            }
        }
        Err(_) => {
            return Err("existing parent is outside its original filesystem scope".to_string())
        }
    };
    let relative = relative.as_path();
    let mut cursor = base.to_path_buf();
    for component in relative.components() {
        cursor.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&cursor)
            .map_err(|err| format!("inspect ancestor {}: {err}", cursor.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "ancestor is a symbolic link or junction: {}",
                cursor.display()
            ));
        }
        if !metadata.is_dir() {
            return Err(format!("ancestor is not a directory: {}", cursor.display()));
        }
    }
    Ok(())
}

fn immediate_parent_anchor(path: &Path) -> Result<DirectoryAnchor, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "snapshot target has no parent directory".to_string())?;
    directory_anchor(parent)
}

fn directory_anchor(path: &Path) -> Result<DirectoryAnchor, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("inspect directory {}: {err}", path.display()))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "directory is a symbolic link or junction: {}",
            path.display()
        ));
    }
    if !metadata.is_dir() {
        return Err(format!("not a directory: {}", path.display()));
    }
    let canonical_path = strip_verbatim_prefix(
        fs::canonicalize(path).map_err(|err| format!("canonicalize {}: {err}", path.display()))?,
    );
    Ok(DirectoryAnchor {
        canonical_path,
        identity: directory_identity(path, &metadata)?,
    })
}

fn validate_directory_anchor(anchor: &DirectoryAnchor) -> Result<(), String> {
    let current = directory_anchor(&anchor.canonical_path)?;
    if path_compare_key(&current.canonical_path) != path_compare_key(&anchor.canonical_path)
        || current.identity != anchor.identity
    {
        return Err(format!(
            "directory anchor was replaced: {}",
            anchor.canonical_path.display()
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn directory_identity(_path: &Path, metadata: &fs::Metadata) -> Result<DirectoryIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    Ok(DirectoryIdentity::Unix {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(windows)]
fn directory_identity(path: &Path, _metadata: &fs::Metadata) -> Result<DirectoryIdentity, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(format!(
            "open directory identity {}: {}",
            path.display(),
            std::io::Error::last_os_error()
        ));
    }
    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let ok = unsafe { GetFileInformationByHandle(handle, info.as_mut_ptr()) };
    let identity_error = (ok == 0).then(std::io::Error::last_os_error);
    unsafe {
        let _ = CloseHandle(handle);
    }
    if let Some(error) = identity_error {
        return Err(format!(
            "read directory identity {}: {error}",
            path.display()
        ));
    }
    let info = unsafe { info.assume_init() };
    Ok(DirectoryIdentity::Windows {
        volume_serial: info.dwVolumeSerialNumber,
        file_index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    })
}

#[cfg(not(any(unix, windows)))]
fn directory_identity(_path: &Path, metadata: &fs::Metadata) -> Result<DirectoryIdentity, String> {
    use std::time::UNIX_EPOCH;
    let created_ns = metadata
        .created()
        .map_err(|err| format!("directory creation time unavailable: {err}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("invalid directory creation time: {err}"))?
        .as_nanos();
    let modified_ns = metadata
        .modified()
        .map_err(|err| format!("directory modification time unavailable: {err}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("invalid directory modification time: {err}"))?
        .as_nanos();
    Ok(DirectoryIdentity::Other {
        created_ns,
        modified_ns,
    })
}

fn read_disk_state(path: &Path, fingerprint_builder: &RandomState) -> Result<DiskState, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(DiskState::Missing),
        Err(err) => return Err(format!("metadata: {err}")),
    };
    if metadata.file_type().is_symlink() {
        return Err("path is a symbolic link".into());
    }
    if !metadata.is_file() {
        return Err("path is not a regular file".into());
    }
    if metadata.len() > MAX_SNAPSHOT_BYTES as u64 {
        return Err(format!(
            "file is too large to verify ({} bytes)",
            metadata.len()
        ));
    }
    let bytes = fs::read(path).map_err(|err| format!("read: {err}"))?;
    Ok(DiskState::File {
        len: metadata.len(),
        fingerprint: fingerprint_builder.hash_one(&bytes),
    })
}

fn path_key(p: &Path) -> String {
    let s = p.to_string_lossy();
    if cfg!(windows) {
        s.to_ascii_lowercase()
    } else {
        s.into_owned()
    }
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn snapshot_list(
    state: State<'_, std::sync::Arc<SnapshotState>>,
    stream_id: String,
) -> Vec<SnapshotInfo> {
    state.list_for_stream(stream_id.trim())
}

#[tauri::command]
pub fn snapshot_restore(
    state: State<'_, std::sync::Arc<SnapshotState>>,
    stream_id: String,
    tool_ids: Vec<String>,
) -> Result<RestoreReport, String> {
    let stream_id = stream_id.trim();
    if stream_id.is_empty() {
        return Err("Stream id required".into());
    }
    let ids: Vec<String> = tool_ids
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    state.restore_tools(stream_id, &ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn test_temp_root() -> PathBuf {
        let root = std::env::temp_dir();
        strip_verbatim_prefix(fs::canonicalize(&root).unwrap_or(root))
    }

    #[cfg(unix)]
    fn symlink_file(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn symlink_file(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    #[cfg(unix)]
    fn symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn symlink_dir(target: &Path, link: &Path) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[test]
    fn restore_created_file_removes_it() {
        let dir = test_temp_root().join(format!("grok-snap-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("new.txt");
        let state = SnapshotState::new();
        state
            .capture_before_write("s1", "t1", &path, "new.txt", &dir, false)
            .unwrap();
        fs::write(&path, b"hello").unwrap();
        state.mark_written("s1", "t1");
        assert!(path.is_file());
        let report = state.restore_tools("s1", &["t1".into()]).unwrap();
        assert!(!path.exists());
        assert_eq!(report.restored.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_modified_file() {
        let dir = test_temp_root().join(format!("grok-snap-m-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.txt");
        {
            let mut f = fs::File::create(&path).unwrap();
            write!(f, "old").unwrap();
        }
        let state = SnapshotState::new();
        state
            .capture_before_write("s1", "t2", &path, "f.txt", &dir, false)
            .unwrap();
        fs::write(&path, b"new").unwrap();
        state.mark_written("s1", "t2");
        state.restore_tools("s1", &["t2".into()]).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_scope_uses_earliest_snapshot_for_each_path() {
        let dir = test_temp_root().join(format!("grok-snap-scope-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.txt");
        fs::write(&path, b"A").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_write("s1", "t1", &path, "f.txt", &dir, false)
            .unwrap();
        fs::write(&path, b"B").unwrap();
        state.mark_written("s1", "t1");
        state
            .capture_before_write("s1", "t2", &path, "f.txt", &dir, false)
            .unwrap();
        fs::write(&path, b"C").unwrap();
        state.mark_written("s1", "t2");

        let report = state
            .restore_tools("s1", &["t1".into(), "t2".into()])
            .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "A");
        assert_eq!(report.restored.len(), 1);
        assert!(state.list_for_stream("s1").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn repeated_capture_in_one_tool_retains_the_earliest_preimage() {
        let dir = test_temp_root().join(format!("grok-snap-repeat-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.txt");
        fs::write(&path, b"A").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_write("s1", "t1", &path, "f.txt", &dir, false)
            .unwrap();
        fs::write(&path, b"B").unwrap();
        state
            .capture_before_write("s1", "t1", &path, "./f.txt", &dir, false)
            .unwrap();
        fs::write(&path, b"C").unwrap();
        state.mark_written("s1", "t1");

        state.restore_tools("s1", &["t1".into()]).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"A");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn incomplete_multi_file_snapshot_refuses_a_partial_restore() {
        let dir = test_temp_root().join(format!("grok-snap-incomplete-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let small = dir.join("small.txt");
        let large = dir.join("large.txt");
        fs::write(&small, b"small-before").unwrap();
        fs::write(&large, vec![b'x'; MAX_SNAPSHOT_BYTES + 1]).unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_write("s1", "t1", &small, "small.txt", &dir, false)
            .unwrap();
        state
            .capture_before_write("s1", "t1", &large, "large.txt", &dir, false)
            .unwrap();
        fs::write(&small, b"small-after").unwrap();
        fs::write(&large, b"large-after").unwrap();
        state.mark_written("s1", "t1");

        let error = state.restore_tools("s1", &["t1".into()]).unwrap_err();
        assert!(error.contains("incomplete"), "{error}");
        assert_eq!(fs::read(&small).unwrap(), b"small-after");
        assert_eq!(fs::read(&large).unwrap(), b"large-after");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshot_capacity_evicts_whole_tool_batches() {
        let dir = test_temp_root().join(format!("grok-snap-evict-batch-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let state = SnapshotState::new();
        for name in ["old-a.txt", "old-b.txt"] {
            state
                .capture_before_write("s1", "old", &dir.join(name), name, &dir, false)
                .unwrap();
        }
        for index in 0..(MAX_ENTRIES - 1) {
            let name = format!("new-{index}.txt");
            state
                .capture_before_write(
                    "s1",
                    &format!("new-{index}"),
                    &dir.join(&name),
                    &name,
                    &dir,
                    false,
                )
                .unwrap();
        }

        let listed = state.list_for_stream("s1");
        assert_eq!(listed.len(), MAX_ENTRIES - 1);
        assert!(listed.iter().all(|entry| entry.tool_id != "old"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_single_tool_batch_cannot_reappear_as_a_partial_snapshot() {
        let dir = test_temp_root().join(format!("grok-snap-single-batch-overflow-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let state = SnapshotState::new();

        for index in 0..(MAX_ENTRIES + 2) {
            let name = format!("file-{index}.txt");
            state
                .capture_before_write("s1", "oversized-tool", &dir.join(&name), &name, &dir, false)
                .unwrap();
        }

        assert!(state.list_for_stream("s1").is_empty());
        let error = state
            .restore_tools("s1", &["oversized-tool".into()])
            .unwrap_err();
        assert!(error.contains("incomplete"), "{error}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_rejects_content_changed_after_mark_written() {
        let dir = test_temp_root().join(format!("grok-snap-conflict-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.txt");
        fs::write(&path, b"old").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_write("s1", "t1", &path, "f.txt", &dir, false)
            .unwrap();
        fs::write(&path, b"agent").unwrap();
        state.mark_written("s1", "t1");
        fs::write(&path, b"other").unwrap();

        let error = state.restore_tools("s1", &["t1".into()]).unwrap_err();
        assert!(error.contains("changed after the edit"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "other");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_deleted_file_recreates_previous_content() {
        let dir = test_temp_root().join(format!("grok-snap-delete-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.txt");
        fs::write(&path, b"old").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_delete("s1", "t1", &path, "f.txt", &dir, false)
            .unwrap();
        fs::remove_file(&path).unwrap();
        state.mark_written("s1", "t1");

        state.restore_tools("s1", &["t1".into()]).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_rejects_file_deleted_after_mark_written() {
        let dir = test_temp_root().join(format!("grok-snap-user-delete-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.txt");
        fs::write(&path, b"old").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_write("s1", "t1", &path, "f.txt", &dir, false)
            .unwrap();
        fs::write(&path, b"agent").unwrap();
        state.mark_written("s1", "t1");
        fs::remove_file(&path).unwrap();

        let error = state.restore_tools("s1", &["t1".into()]).unwrap_err();
        assert!(error.contains("changed after the edit"), "{error}");
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_rejects_file_recreated_after_agent_delete() {
        let dir = test_temp_root().join(format!("grok-snap-recreate-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("f.txt");
        fs::write(&path, b"old").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_delete("s1", "t1", &path, "f.txt", &dir, false)
            .unwrap();
        fs::remove_file(&path).unwrap();
        state.mark_written("s1", "t1");
        fs::write(&path, b"user").unwrap();

        let error = state.restore_tools("s1", &["t1".into()]).unwrap_err();
        assert!(error.contains("changed after the edit"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "user");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_rejects_changed_agent_created_file() {
        let dir = test_temp_root().join(format!("grok-snap-created-conflict-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("new.txt");
        let state = SnapshotState::new();

        state
            .capture_before_write("s1", "t1", &path, "new.txt", &dir, false)
            .unwrap();
        fs::write(&path, b"agent").unwrap();
        state.mark_written("s1", "t1");
        fs::write(&path, b"user").unwrap();

        let error = state.restore_tools("s1", &["t1".into()]).unwrap_err();
        assert!(error.contains("changed after the edit"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "user");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_rejects_missing_parent_without_recreating_it() {
        let dir = test_temp_root().join(format!("grok-snap-missing-parent-{}", now_ms()));
        let parent = dir.join("nested");
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join("f.txt");
        fs::write(&path, b"old").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_delete("s1", "t1", &path, "nested/f.txt", &dir, false)
            .unwrap();
        fs::remove_file(&path).unwrap();
        state.mark_written("s1", "t1");
        fs::remove_dir(&parent).unwrap();

        let error = state.restore_tools("s1", &["t1".into()]).unwrap_err();
        assert!(error.contains("parent directory"), "{error}");
        assert!(!parent.exists());
        assert_eq!(state.list_for_stream("s1").len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_rejects_replaced_parent_even_with_matching_content() {
        let dir = test_temp_root().join(format!("grok-snap-replaced-parent-{}", now_ms()));
        let parent = dir.join("nested");
        fs::create_dir_all(&parent).unwrap();
        let path = parent.join("f.txt");
        fs::write(&path, b"old").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_write("s1", "t1", &path, "nested/f.txt", &dir, false)
            .unwrap();
        fs::write(&path, b"agent").unwrap();
        state.mark_written("s1", "t1");
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&parent).unwrap();
        fs::create_dir(&parent).unwrap();
        fs::write(&path, b"agent").unwrap();

        let error = state.restore_tools("s1", &["t1".into()]).unwrap_err();
        assert!(error.contains("parent directory was replaced"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "agent");
        assert_eq!(state.list_for_stream("s1").len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_capability_cannot_be_redirected_after_parent_validation() {
        use std::cell::Cell;

        for (index, kind) in [
            SnapshotKind::Created,
            SnapshotKind::Modified,
            SnapshotKind::Deleted,
        ]
        .into_iter()
        .enumerate()
        {
            let dir = test_temp_root().join(format!("grok-snap-parent-race-{}-{index}", now_ms()));
            let workspace = dir.join("workspace");
            let parent = workspace.join("nested");
            let moved_parent = workspace.join("moved");
            let path = parent.join("f.txt");
            fs::create_dir_all(&parent).unwrap();
            if kind != SnapshotKind::Created {
                fs::write(&path, b"before").unwrap();
            }
            let state = SnapshotState::new();
            match kind {
                SnapshotKind::Created | SnapshotKind::Modified => state
                    .capture_before_write("s1", "t1", &path, "nested/f.txt", &workspace, false)
                    .unwrap(),
                SnapshotKind::Deleted => state
                    .capture_before_delete("s1", "t1", &path, "nested/f.txt", &workspace, false)
                    .unwrap(),
            }
            match kind {
                SnapshotKind::Created | SnapshotKind::Modified => {
                    fs::write(&path, b"agent").unwrap()
                }
                SnapshotKind::Deleted => fs::remove_file(&path).unwrap(),
            }
            state.mark_written("s1", "t1");
            let entry = {
                let guard = state.inner.lock().unwrap();
                guard.by_key.values().next().unwrap().clone()
            };
            let swapped = Cell::new(false);

            restore_one_with_hook(&entry, &entry, &state.fingerprint_builder, || {
                if fs::rename(&parent, &moved_parent).is_ok() {
                    swapped.set(true);
                    fs::create_dir(&parent).unwrap();
                    fs::write(&path, b"decoy").unwrap();
                }
            })
            .unwrap();

            let restored_path = if swapped.get() {
                assert_eq!(fs::read(&path).unwrap(), b"decoy");
                moved_parent.join("f.txt")
            } else {
                // Windows keeps the opened directory non-renamable; either
                // outcome remains bound to the verified parent capability.
                path.clone()
            };
            if kind == SnapshotKind::Created {
                assert!(!restored_path.exists());
            } else {
                assert_eq!(fs::read(restored_path).unwrap(), b"before");
            }
            let _ = fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn restore_rejects_final_component_symlink_and_preserves_outside_target() {
        let dir = test_temp_root().join(format!("grok-snap-final-link-{}", now_ms()));
        let workspace = dir.join("workspace");
        let outside = dir.join("outside.txt");
        fs::create_dir_all(&workspace).unwrap();
        let path = workspace.join("f.txt");
        fs::write(&path, b"old").unwrap();
        fs::write(&outside, b"agent").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_write("s1", "t1", &path, "f.txt", &workspace, false)
            .unwrap();
        fs::write(&path, b"agent").unwrap();
        state.mark_written("s1", "t1");
        fs::remove_file(&path).unwrap();
        if symlink_file(&outside, &path).is_err() {
            let _ = fs::remove_dir_all(&dir);
            return;
        }

        let error = state.restore_tools("s1", &["t1".into()]).unwrap_err();
        assert!(error.contains("final path component"), "{error}");
        assert_eq!(fs::read_to_string(&outside).unwrap(), "agent");
        assert_eq!(state.list_for_stream("s1").len(), 1);
        let _ = fs::remove_file(&path);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_rejects_ancestor_symlink_and_preserves_outside_target() {
        let dir = test_temp_root().join(format!("grok-snap-ancestor-link-{}", now_ms()));
        let workspace = dir.join("workspace");
        let parent = workspace.join("nested");
        let outside = dir.join("outside");
        fs::create_dir_all(&parent).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let path = parent.join("f.txt");
        let outside_path = outside.join("f.txt");
        fs::write(&path, b"old").unwrap();
        fs::write(&outside_path, b"agent").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_write("s1", "t1", &path, "nested/f.txt", &workspace, false)
            .unwrap();
        fs::write(&path, b"agent").unwrap();
        state.mark_written("s1", "t1");
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&parent).unwrap();
        if symlink_dir(&outside, &parent).is_err() {
            let _ = fs::remove_dir_all(&dir);
            return;
        }

        let error = state.restore_tools("s1", &["t1".into()]).unwrap_err();
        assert!(error.contains("symbolic link or junction"), "{error}");
        assert_eq!(fs::read_to_string(&outside_path).unwrap(), "agent");
        assert_eq!(state.list_for_stream("s1").len(), 1);
        let _ = fs::remove_dir(&parent);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn restore_rejects_windows_junction_escape_when_available() {
        let dir = test_temp_root().join(format!("grok-snap-junction-{}", now_ms()));
        let workspace = dir.join("workspace");
        let parent = workspace.join("nested");
        let outside = dir.join("outside");
        fs::create_dir_all(&parent).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let path = parent.join("f.txt");
        let outside_path = outside.join("f.txt");
        fs::write(&path, b"old").unwrap();
        fs::write(&outside_path, b"agent").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_write("s1", "t1", &path, "nested/f.txt", &workspace, false)
            .unwrap();
        fs::write(&path, b"agent").unwrap();
        state.mark_written("s1", "t1");
        fs::remove_file(&path).unwrap();
        fs::remove_dir(&parent).unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&parent)
            .arg(&outside)
            .status();
        if !status.map(|status| status.success()).unwrap_or(false) {
            let _ = fs::remove_dir_all(&dir);
            return;
        }

        let error = state.restore_tools("s1", &["t1".into()]).unwrap_err();
        assert!(error.contains("symbolic link or junction"), "{error}");
        assert_eq!(fs::read_to_string(&outside_path).unwrap(), "agent");
        assert_eq!(state.list_for_stream("s1").len(), 1);
        let _ = fs::remove_dir(&parent);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_access_restore_uses_the_original_parent_anchor() {
        let dir = test_temp_root().join(format!("grok-snap-full-access-{}", now_ms()));
        let workspace = dir.join("workspace");
        let outside = dir.join("outside");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let path = outside.join("f.txt");
        fs::write(&path, b"old").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_write("s1", "t1", &path, "outside/f.txt", &workspace, true)
            .unwrap();
        fs::write(&path, b"agent").unwrap();
        state.mark_written("s1", "t1");
        state.restore_tools("s1", &["t1".into()]).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "old");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn workspace_capture_rejects_outside_target_without_changing_it() {
        let dir = test_temp_root().join(format!("grok-snap-outside-{}", now_ms()));
        let workspace = dir.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        let outside = dir.join("outside.txt");
        fs::write(&outside, b"outside").unwrap();
        let state = SnapshotState::new();

        let error = state
            .capture_before_write("s1", "t1", &outside, "outside.txt", &workspace, false)
            .unwrap_err();
        assert!(error.contains("outside"), "{error}");
        assert_eq!(fs::read_to_string(&outside).unwrap(), "outside");
        assert!(state.list_for_stream("s1").is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn duplicate_tool_ids_are_isolated_by_stream() {
        let dir = test_temp_root().join(format!("grok-snap-stream-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        let first = dir.join("first.txt");
        let second = dir.join("second.txt");
        fs::write(&first, b"old-first").unwrap();
        fs::write(&second, b"old-second").unwrap();
        let state = SnapshotState::new();

        state
            .capture_before_write("s1", "same-tool", &first, "first.txt", &dir, false)
            .unwrap();
        fs::write(&first, b"new-first").unwrap();
        state.mark_written("s1", "same-tool");
        state
            .capture_before_write("s2", "same-tool", &second, "second.txt", &dir, false)
            .unwrap();
        fs::write(&second, b"new-second").unwrap();
        state.mark_written("s2", "same-tool");

        state.restore_tools("s1", &["same-tool".into()]).unwrap();
        assert_eq!(fs::read_to_string(&first).unwrap(), "old-first");
        assert_eq!(fs::read_to_string(&second).unwrap(), "new-second");
        assert_eq!(state.list_for_stream("s2").len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
