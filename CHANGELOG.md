# Changelog

All notable Open Xiao changes will be recorded in this file.

## [Unreleased]

### Fixed

- Isolated file fresh-read capabilities by chat stream and revoked active terminal
  sessions when their workspace is unregistered.
- Bounded aggregate chat payloads, provider error-body reads, and OpenCode event
  stream lifetimes; stale OpenCode approvals are now cleared with their stream.
- Rejected unknown execution modes instead of silently enabling automatic Build
  behavior.
- Settled failed project-file searches and Review Undo availability without stale
  loading or cross-thread state.

### Changed

- Added executable React interaction tests, extracted Review Undo availability
  from the application shell, and lazy-loaded the project file picker.
- Added lint, typecheck, and production-build CI coverage for the standalone website.
- Added a searchable local/remote Git ref picker and validated base-branch
  selection for new isolated worktrees.
- Finalized stable and beta application identifiers under the Open Xiao namespace.
- Added repeatable Windows CI checks for tests, typechecking, builds, Rust linting,
  formatting, dependency audits, and native bundle creation.
- Added release acceptance and security-reporting documentation.

## [0.1.0] - Unreleased

Initial official Windows release.
