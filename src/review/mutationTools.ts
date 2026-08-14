/** Canonical file-mutation tool names (write/edit family). Keep in sync with Rust `is_mutation_tool`. */
const FILE_MUTATION_TOOLS = new Set([
  "write",
  "write_file",
  "edit",
  "edit_file",
  "str_replace",
  "patch",
  "apply_patch",
  "applypatch",
]);

/** Tools that capture pre-write snapshots for undo (includes delete). */
const SNAPSHOT_MUTATION_TOOLS = new Set([
  ...FILE_MUTATION_TOOLS,
  "delete",
  "delete_file",
]);

export function isFileMutationTool(name: string): boolean {
  return FILE_MUTATION_TOOLS.has(name.toLowerCase());
}

export function isSnapshotMutationTool(name: string): boolean {
  return SNAPSHOT_MUTATION_TOOLS.has(name.toLowerCase());
}

export function isWriteTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === "write" || n === "write_file";
}

export function isEditTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "edit" ||
    n === "edit_file" ||
    n === "str_replace" ||
    n === "apply_patch" ||
    n === "applypatch"
  );
}
