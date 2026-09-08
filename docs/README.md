# T3 Trade docs

## Trading

- [Trading execution and reconciliation](./architecture/trading-execution.md)
- [The final form: product plan, TRADE.md lifecycle, and drift fences](./internals/trading-final-form.md)
- [Trading with the agent](./user/trading.md)
- [The fork's contract with upstream](./upstream/) — baseline, patch ledger, sync runbook

---

## Using T3 Trade

- [Install T3 Code](./user/install.md)
- [Messages and context](./user/composer.md)
- [Working with threads](./user/thread-sidebar.md)
- [Permission modes](./user/permission-modes.md)
- [Terminal history](./user/terminal.md)
- [Source control](./user/source-control.md)
- [Project settings](./user/project-settings.md)
- [Appearance and themes](./user/appearance.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Developing an idea](./user/developing-an-idea.md)
- [Studying events](./user/studying-events.md)
- [Validating a trading idea](./user/validating-an-idea.md)
- [Import browser sessions](./user/browser-import.md)
- [Usage and limits](./user/usage.md)
- [Product usage data](./user/telemetry.md)
- [Remote access](./user/remote-access.md)
- [Running in the background](./user/background-service.md)
- [Updating T3 Code](./user/updating.md)
- Provider guides: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md) · [OpenCode](./user/providers-opencode.md) · [Antigravity](./user/providers-antigravity.md)

---

## Working on T3 Trade

Start with the [development runbook](./operations/development.md) and
[contribution policy](../CONTRIBUTING.md).

Internal notes preserve architectural decisions, constraints, and implementation traps that the
source alone does not explain. Most code changes do not need an internal documentation update. Follow the
[documentation rules](../AGENTS.md#documentation) before adding one.

- [Architecture overview](./internals/overview.md)
- [Glossary](./internals/glossary.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Model classification](./internals/model-manifest.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md)
- [Assistant citations](./internals/assistant-citations.md)
- [Mobile navigation](./internals/mobile-navigation.md)
- [Mobile development lifecycle](./internals/mobile-development.md)
- [Terminal runtime](./internals/terminal-runtime.md)
- [Voice input](./internals/voice-input.md)

### Runbooks

- [Development and local builds](./operations/development.md)
- [T3 Connect setup](./operations/connect-setup.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
