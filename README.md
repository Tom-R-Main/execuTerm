<h1 align="center">execuTerm</h1>
<p align="center">A Ghostty-based macOS terminal with vertical tabs and notifications for AI coding agents</p>

<p align="center">
  <a href="https://github.com/Tom-R-Main/execuTerm/releases/latest/download/execuTerm-macos.dmg">
    <img src="./docs/assets/macos-badge.png" alt="Download execuTerm for macOS" width="180" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/Tom-R-Main/execuTerm"><img src="https://img.shields.io/badge/GitHub-555?logo=github" alt="GitHub" /></a>
</p>

<p align="center">
  <img src="./docs/assets/main-first-image.png" alt="execuTerm screenshot" width="900" />
</p>

<p align="center">
  <a href="https://github.com/Tom-R-Main/execuTerm#the-zen-of-executerm">The Zen of execuTerm</a>
</p>

## Features

<table>
<tr>
<td width="40%" valign="middle">
<h3>Notification rings</h3>
Panes get a blue ring and tabs light up when coding agents need your attention
</td>
<td width="60%">
<img src="./docs/assets/notification-rings.png" alt="Notification rings" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Notification panel</h3>
See all pending notifications in one place, jump to the most recent unread
</td>
<td width="60%">
<img src="./docs/assets/sidebar-notification-badge.png" alt="Sidebar notification badge" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>In-app browser</h3>
Split a browser alongside your terminal with a scriptable API ported from <a href="https://github.com/vercel-labs/agent-browser">agent-browser</a>
</td>
<td width="60%">
<img src="./docs/assets/built-in-browser.png" alt="Built-in browser" width="100%" />
</td>
</tr>
<tr>
<td width="40%" valign="middle">
<h3>Vertical + horizontal tabs</h3>
Sidebar shows git branch, linked PR status/number, working directory, listening ports, and latest notification text. Split horizontally and vertically.
</td>
<td width="60%">
<img src="./docs/assets/vertical-horizontal-tabs-and-splits.png" alt="Vertical tabs and split panes" width="100%" />
</td>
</tr>
</table>

- **Scriptable** — CLI and socket API to create workspaces, split panes, send keystrokes, and automate the browser
- **Native macOS app** — Built with Swift and AppKit, not Electron. Fast startup, low memory.
- **Ghostty compatible** — Reads your existing `~/.config/ghostty/config` for themes, fonts, and colors
- **GPU-accelerated** — Powered by libghostty for smooth rendering

## Install

### DMG (recommended)

<a href="https://github.com/Tom-R-Main/execuTerm/releases/latest/download/execuTerm-macos.dmg">
  <img src="./docs/assets/macos-badge.png" alt="Download execuTerm for macOS" width="180" />
</a>

Open the `.dmg` and drag execuTerm to your Applications folder. execuTerm auto-updates via Sparkle, so you only need to download once.

### Homebrew

Homebrew packaging has not been re-published under the execuTerm name yet. For now, use the signed DMG above.

On first launch, macOS may ask you to confirm opening an app from an identified developer. Click **Open** to proceed.

## Why execuTerm?

I run a lot of Claude Code and Codex sessions in parallel. I was using Ghostty with a bunch of split panes, and relying on native macOS notifications to know when an agent needed me. But Claude Code's notification body is always just "Claude is waiting for your input" with no context, and with enough tabs open I couldn't even read the titles anymore.

I tried a few coding orchestrators but most of them were Electron/Tauri apps and the performance bugged me. I also just prefer the terminal since GUI orchestrators lock you into their workflow. So I built execuTerm as a native macOS app in Swift/AppKit. It uses libghostty for terminal rendering and reads your existing Ghostty config for themes, fonts, and colors.

The main additions are the sidebar and notification system. The sidebar has vertical tabs that show git branch, linked PR status/number, working directory, listening ports, and the latest notification text for each workspace. The notification system picks up terminal sequences (OSC 9/99/777) and has a CLI notification helper you can wire into agent hooks for Claude Code, OpenCode, and similar tools. When an agent is waiting, its pane gets a blue ring and the tab lights up in the sidebar, so I can tell which one needs me across splits and tabs. Cmd+Shift+U jumps to the most recent unread.

The in-app browser has a scriptable API ported from [agent-browser](https://github.com/vercel-labs/agent-browser). Agents can snapshot the accessibility tree, get element refs, click, fill forms, and evaluate JS. You can split a browser pane next to your terminal and have Claude Code interact with your dev server directly.

Everything is scriptable through the CLI and socket API — create workspaces/tabs, split panes, send keystrokes, open URLs in the browser.

## The Zen of execuTerm

execuTerm is not prescriptive about how developers hold their tools. It's a terminal and browser with a CLI, and the rest is up to you.

execuTerm is a primitive, not a solution. It gives you a terminal, a browser, notifications, workspaces, splits, tabs, and a CLI to control all of it. execuTerm doesn't force you into an opinionated way to use coding agents. What you build with the primitives is yours.

The best developers have always built their own tools. Nobody has figured out the best way to work with agents yet, and the teams building closed products definitely haven't either. The developers closest to their own codebases will figure it out first.

Give a million developers composable primitives and they'll collectively find the most efficient workflows faster than any product team could design top-down.

## Documentation

For more info on how to configure execuTerm, start with this repository's documentation and release notes:

- [README](https://github.com/Tom-R-Main/execuTerm#readme)
- [Release notes](https://github.com/Tom-R-Main/execuTerm/releases)

## Keyboard Shortcuts

### Workspaces

| Shortcut | Action |
|----------|--------|
| ⌘ N | New workspace |
| ⌘ 1–8 | Jump to workspace 1–8 |
| ⌘ 9 | Jump to last workspace |
| ⌃ ⌘ ] | Next workspace |
| ⌃ ⌘ [ | Previous workspace |
| ⌘ ⇧ W | Close workspace |
| ⌘ ⇧ R | Rename workspace |
| ⌘ B | Toggle sidebar |

### Surfaces

| Shortcut | Action |
|----------|--------|
| ⌘ T | New surface |
| ⌘ ⇧ ] | Next surface |
| ⌘ ⇧ [ | Previous surface |
| ⌃ Tab | Next surface |
| ⌃ ⇧ Tab | Previous surface |
| ⌃ 1–8 | Jump to surface 1–8 |
| ⌃ 9 | Jump to last surface |
| ⌘ W | Close surface |

### Split Panes

| Shortcut | Action |
|----------|--------|
| ⌘ D | Split right |
| ⌘ ⇧ D | Split down |
| ⌥ ⌘ ← → ↑ ↓ | Focus pane directionally |
| ⌘ ⇧ H | Flash focused panel |

### Browser

Browser developer-tool shortcuts follow Safari defaults and are customizable in `Settings → Keyboard Shortcuts`.

| Shortcut | Action |
|----------|--------|
| ⌘ ⇧ L | Open browser in split |
| ⌘ L | Focus address bar |
| ⌘ [ | Back |
| ⌘ ] | Forward |
| ⌘ R | Reload page |
| ⌥ ⌘ I | Toggle Developer Tools (Safari default) |
| ⌥ ⌘ C | Show JavaScript Console (Safari default) |

### Notifications

| Shortcut | Action |
|----------|--------|
| ⌘ I | Show notifications panel |
| ⌘ ⇧ U | Jump to latest unread |

### Find

| Shortcut | Action |
|----------|--------|
| ⌘ F | Find |
| ⌘ G / ⌘ ⇧ G | Find next / previous |
| ⌘ ⇧ F | Hide find bar |
| ⌘ E | Use selection for find |

### Terminal

| Shortcut | Action |
|----------|--------|
| ⌘ K | Clear scrollback |
| ⌘ C | Copy (with selection) |
| ⌘ V | Paste |
| ⌘ + / ⌘ - | Increase / decrease font size |
| ⌘ 0 | Reset font size |

### Window

| Shortcut | Action |
|----------|--------|
| ⌘ ⇧ N | New window |
| ⌘ , | Settings |
| ⌘ ⇧ , | Reload configuration |
| ⌘ Q | Quit |

## Nightly Builds

Public nightly builds have not been re-published under the execuTerm name yet. Until that channel is restored, use the latest stable DMG from [GitHub Releases](https://github.com/Tom-R-Main/execuTerm/releases).

Report nightly bugs on [GitHub Issues](https://github.com/Tom-R-Main/execuTerm/issues) or in [#nightly-bugs on Discord](https://discord.gg/xsgFEVrWCZ).

## Session restore (current behavior)

On relaunch, execuTerm currently restores app layout and metadata only:
- Window/workspace/pane layout
- Working directories
- Terminal scrollback (best effort)
- Browser URL and navigation history

execuTerm does **not** restore live process state inside terminal apps. For example, active Claude Code/tmux/vim sessions are not resumed after restart yet.

## Star History

<a href="https://star-history.com/#Tom-R-Main/execuTerm&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Tom-R-Main/execuTerm&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Tom-R-Main/execuTerm&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Tom-R-Main/execuTerm&type=Date" width="600" />
 </picture>
</a>

## Contributing

- Create and participate in [GitHub Issues](https://github.com/Tom-R-Main/execuTerm/issues)
- Let us know what you're building with execuTerm

## Upstream Credits

execuTerm is built on top of the original [cmux](https://github.com/manaflow-ai/cmux) work from Manaflow. This fork keeps that lineage explicit and aims to preserve upstream credit while evolving the product around execuTerm's dashboard-first AI workflow, release channel, and branding.

## Founder's Edition

execuTerm is free, open source, and always will be. If you'd like to support development and get early access to what's coming next:

**[Get Founder's Edition](https://buy.stripe.com/3cI00j2Ld0it5OU33r5EY0q)**

- **Prioritized feature requests/bug fixes**
- **Early access: execuTerm AI that gives you context on every workspace, tab and panel**
- **Early access: iOS app with terminals synced between desktop and phone**
- **Early access: Cloud VMs**
- **Early access: Voice mode**
- **My personal iMessage/WhatsApp**

## License

This project is licensed under the GNU Affero General Public License v3.0 or later (`AGPL-3.0-or-later`).

See `LICENSE` for the full text.
