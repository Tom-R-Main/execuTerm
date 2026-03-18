# Upstream cmux tracking

## Base

- **Upstream repo:** https://github.com/manaflow-ai/cmux
- **Fork base commit:** See `git log --oneline upstream/main -1` for the current base
- **Fork remote:** `upstream` (configured in this repo's git remotes)

## Merge policy

- Periodically merge `upstream/main` into our working branch to stay current
- Resolve conflicts in favor of upstream for terminal/rendering code
- Resolve conflicts in favor of execuTerm for daemon and branding changes
- Always run the full test suite after merging upstream changes

## Divergence points

### Branding (planned)
- Product name: cmux → execuTerm
- Bundle identifier: TBD
- App icon, about window, help menu links
- Sparkle update URL

### Daemon integration (planned)
- Auto-launch daemon from AppDelegate
- Bundle compiled daemon binary in app resources
- Pass socket path and config via environment

### No changes to
- Terminal rendering engine (Ghostty)
- Socket v1/v2 protocol
- Workspace/surface/pane management
- Browser panel
- Claude Code hook system
- CLI tool (except product name)
