# Attribution

## Built on cmux by Manaflow

execuTerm is built on top of [cmux](https://github.com/manaflow-ai/cmux), a
native macOS terminal application created by the [Manaflow](https://manaflow.ai)
team. cmux provides the terminal rendering engine, workspace management, socket
control API, in-app browser, and Claude Code hook integration that execuTerm
relies on.

We are grateful to the Manaflow team for building cmux as open-source software
under the AGPL-3.0 license, which makes projects like execuTerm possible.

**Upstream repository:** https://github.com/manaflow-ai/cmux
**License:** GNU Affero General Public License v3.0 (AGPL-3.0)

## What execuTerm adds

execuTerm layers an orchestration daemon on top of cmux that connects to the
[ExecuFunction](https://execufunction.com) platform. This daemon:

- Authenticates with ExecuFunction using shared `exf` CLI credentials
- Dispatches ExecuFunction tasks to AI coding agents (Claude Code, Codex, Gemini)
- Manages agent lifecycle and workspace state
- Provides a local dashboard showing agents, tasks, calendar, and dev servers
- Monitors dev server health and pushes status to the cmux sidebar

The terminal substrate (rendering, input handling, splits, tabs, browser panels,
socket API) is cmux. The intelligence layer (auth, task dispatch, agent state,
ExecuFunction sync) is execuTerm.

## Third-party licenses

See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) for licenses of all
bundled dependencies (inherited from upstream cmux).
