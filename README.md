# Open Xiao

Open Xiao desktop agent client (Tauri 2 + React 19 + TypeScript). Chat, project tools, git worktrees, plan/review panels, and separate Grok/xAI and OpenAI model catalogs.

OpenAI access is native: the app signs in with ChatGPT OAuth and calls the OpenAI Responses API directly — no Codex CLI wrapper.

## Release status

Open Xiao 0.1 is preparing for its first official Windows release. No public
installer should be treated as official until it is built from a clean tagged
commit, passes the release checklist, and has a valid publisher signature.

The initial supported target is Windows x64 with WebView2. macOS and Linux are
development targets only until platform-native packaging and acceptance checks
are run on those operating systems.

## Prerequisites

- Node.js 20+
- Rust (stable) + [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) (Windows: WebView2)

## Setup

```bash
npm install
```

## Develop

```bash
# Vite only (no native backend / OAuth)
npm run dev

# Full desktop app
npm run app
# or: npm run tauri dev
```

## Test / build

```bash
npm run test:app          # frontend unit tests
npm run typecheck         # tsc --noEmit
npm test                  # app tests + cargo test
npm run build             # tsc && vite build
npm run tauri -- build    # desktop bundle
npm run verify:release    # tests + typecheck + build + Rust tests/Clippy/rustfmt
```

## Security model

Open Xiao is a local coding-agent client. Depending on the selected permission
mode, an agent can read and modify workspace files, run commands, create
worktrees, and access configured providers. Ask mode requires approval for
mutation, command, and task tools, including nested agent tools.

Provider sessions are stored in an encrypted local vault backed by the operating
system credential store. Prompts, workspace content, and provider requests leave
the machine only when required by the provider or a user-approved network tool.
Do not paste credentials into prompts or issue reports.

See [SECURITY.md](SECURITY.md) for reporting guidance and
[docs/release-checklist.md](docs/release-checklist.md) for the official release
gates.

## Agent notes

See `AGENTS.md` and `src-tauri/AGENTS_CODING.md`.
