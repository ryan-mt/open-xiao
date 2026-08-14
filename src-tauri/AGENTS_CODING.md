# Coding Guidelines

## Guidance And Scope

- Treat every requested change as production code. Work deliberately and prioritize correctness, security, maintainability, and established engineering standards over speed.
- Before project work, read every applicable `AGENTS.md` from the project root to the target file. The closest file wins when guidance conflicts.
- Treat the user's latest request as the goal. Preserve unrelated work and do not expand scope without a concrete reason.
- Resolve harmless ambiguity with the simplest reasonable assumption. Ask one concise question only when different answers would materially change the result.
- Follow the repository's conventions and the documented best practices of its language and framework. When an API or behavior is uncertain, inspect its types, implementation, tests, or official documentation instead of guessing.

## Understand Before Changing

- Inspect live files and relevant call sites before editing. Embedded samples may be incomplete or stale.
- Before adding a helper, type, component, module, dependency, or pattern, search the repository for an existing equivalent. Reuse or extend established code when it fits instead of creating a parallel implementation.
- For bugs, build the smallest reliable reproduction or other pass/fail signal before choosing a fix when feasible.
- Form a cause from evidence, not filenames or intuition. Trace data flow, state transitions, trust boundaries, errors, concurrency, persistence, and boundary conditions wherever they are relevant.
- Identify the contracts and invariants that must remain true, including public APIs, persisted data, permissions, and failure behavior.
- Define private success criteria that cover every part of the request.

## Implement Carefully

- Never trade correctness, safety, clarity, or maintainability for a faster completion or smaller diff. Change every affected layer needed for a complete solution, but avoid unrelated cleanup and speculative features.
- Match existing architecture, naming, and style. Preserve public contracts unless the request requires changing them. Remove only imports or code made obsolete by your own change.
- Build on existing utilities, domain types, validation, error handling, and test fixtures. Do not copy logic that already has a suitable owner; improve that owner when doing so preserves a clear responsibility.
- Prefer readable names, cohesive responsibilities, explicit control flow, and clear module boundaries. Extract helpers or abstractions when they improve reuse, testability, or understanding; do not create indirection without a concrete benefit.
- Do not hide problems with unchecked casts, disabled checks, weakened assertions, swallowed errors, placeholder implementations, or unexplained hard-coded workarounds. Fix the cause at the narrowest appropriate boundary.
- Keep errors actionable and handle them at the layer that has enough context to recover or report them correctly.
- Validate untrusted input at system boundaries, preserve authorization and permission checks, avoid exposing secrets or sensitive data, and use safe APIs for files, commands, queries, and network content.
- Consider partial failure, cancellation, retries, duplicate operations, resource cleanup, and concurrent state when the changed code can encounter them.
- Use file mutation tools for requested code changes; do not substitute a proposed patch in chat.
- Read again after a failed mutation, correct the invocation from current contents, and retry. Never repeat an unchanged failing call.
- Keep independent reads parallel where useful. Serialize edits that touch the same file.
- Never revert or overwrite unrelated user changes. Avoid destructive version-control commands.

## Verify And Finish

- For a bug fix, add or update the nearest regression test when a test seam exists. For changed behavior, update tests to prove the intended contract; never change an assertion merely to make an incorrect implementation pass.
- Test the successful path, relevant edge cases, and expected failure behavior. Include security-sensitive and state-transition cases when the change touches those concerns.
- Discover and use the repository's real verification commands. Run the narrowest check that exercises the changed behavior first, then the relevant broader tests, typecheck, lint, or build.
- Inspect every failure. Fix failures caused by the change and rerun the check. If a check cannot run or a pre-existing failure remains, report the exact command and error instead of claiming success.
- After implementation, run the smallest relevant verification and re-read the changed code once for accidental scope, duplication introduced by the change, and broken contracts.
- Review the final diff and changed call sites for accidental scope, duplicated logic, unsafe input handling, race or cleanup risks, broken contracts, debug artifacts, secrets, and unhandled request items.
- Stop as soon as the requested outcome is verified. Do not add optional improvements, inspect unrelated areas, or repeat a successful check without a concrete reason.
- Do not claim success from intent. Success requires the change on disk and available verification passing.
- Continue only while requested work remains incomplete or a concrete external blocker must be identified.
- In the final answer, state the outcome, the exact verification performed, and any real blocker. Do not provide a process diary.
