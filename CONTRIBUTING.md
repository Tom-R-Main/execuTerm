# Contributing to execuTerm

Thanks for your interest in contributing. execuTerm is a native macOS terminal built for running AI coding agents, with a dashboard, ExecuFunction integration, and context injection. It's built on Swift/AppKit with libghostty for terminal rendering.

## Prerequisites

- macOS 14 (Sonoma) or later
- Xcode 16+
- [Zig](https://ziglang.org/) — `brew install zig`
- Node.js 20+ (for the daemon)

## Setup

```bash
git clone --recursive https://github.com/Tom-R-Main/execuTerm.git
cd execuTerm
./scripts/setup.sh
```

This initializes submodules and builds the GhosttyKit xcframework from source.

## Building

```bash
# Debug build — launches a tagged instance that won't conflict with a running release app
./scripts/reload.sh --tag my-feature

# Release build
./scripts/reloadp.sh
```

Always use `--tag` for debug builds. Untagged builds share the default socket and bundle ID, which causes conflicts if you have the release app running.

## Architecture

```
Sources/              Swift app — windows, tabs, splits, sidebar, notifications
daemon/               Node.js daemon — dashboard server, ExecuFunction sync, agent lifecycle
ghostty/              Submodule — libghostty fork for terminal rendering
scripts/              Build, release, and dev tooling
```

**Swift app** handles the native UI: workspaces, split panes, vertical tabs, notification rings, browser panels, keyboard shortcuts, and the scriptable socket API.

**Daemon** runs inside the app bundle and serves the dashboard UI, manages ExecuFunction authentication, syncs tasks/context, and handles agent dispatch. Built with TypeScript, packaged as standalone Node.js binaries for arm64 and x64.

## Making changes

### Swift (app UI, terminal, notifications)

The main entry point is `Sources/main.swift`. Key files:

- `Sources/cmuxApp.swift` — SwiftUI app lifecycle
- `Sources/ContentView.swift` — Tab bar and workspace switching
- `Sources/Workspace.swift` — Workspace model with splits and browser panels
- `Sources/AppDelegate.swift` — Socket server, keyboard handling, window management
- `Sources/ExecuTermDaemonController.swift` — Daemon lifecycle and health checks

### Daemon (dashboard, ExecuFunction integration)

```bash
cd daemon
npm install
npm run dev    # Watch mode
npm test       # Jest tests
npx tsc --noEmit  # Type check
```

Key files:

- `daemon/src/index.ts` — Entry point, socket connection, command dispatch
- `daemon/src/services/dashboardServer.ts` — Dashboard HTTP server and UI
- `daemon/src/services/agentManager.ts` — Agent session tracking
- `daemon/src/services/workspaceManager.ts` — Workspace/directory state

### Ghostty submodule

If you need to change terminal rendering, the submodule is a fork. Push submodule commits before updating the pointer in the parent repo. See `docs/ghostty-fork.md` for fork details.

Rebuild the xcframework after ghostty changes:

```bash
cd ghostty && zig build -Demit-xcframework=true -Dxcframework-target=universal -Doptimize=ReleaseFast
```

## Testing

Tests run via CI. Do not run E2E or UI tests locally — they require a dedicated environment.

```bash
# Type check (safe to run locally)
cd daemon && npx tsc --noEmit

# Daemon unit tests (safe to run locally)
cd daemon && npm test

# Swift unit tests (safe, no app launch)
xcodebuild -scheme cmux-unit -destination 'platform=macOS' test
```

## Pull requests

- Keep PRs focused. One logical change per PR.
- Include a clear description of what changed and why.
- If you're adding a user-visible string, it must be localized via `String(localized:defaultValue:)` and added to `Resources/Localizable.xcstrings`.
- Run `npx tsc --noEmit` in the daemon directory before submitting.

## License

By contributing, you agree that your contributions are licensed under [AGPL-3.0-or-later](LICENSE).
