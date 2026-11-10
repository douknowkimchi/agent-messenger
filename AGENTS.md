# agent-messenger

Multi-platform messaging CLI for AI agents (Slack, Discord, Teams).

## Platform Notes

Each platform lives in `src/platforms/<name>/` and follows the same convention (cli, index, client, types, credential-manager, ensure-auth, commands). **iMessage (`agent-imessage`) is the one platform that must run on a Mac:** Apple has no public API, so it shells out to the local [imsg](https://github.com/openclaw/imsg) CLI and talks to it over JSON-RPC (stdin/stdout) — there is no network/server. Its client (`ImsgClient`, over an `ImsgRpc` transport) spawns a long-lived `imsg rpc` child for chats/history/watch/send, and shells out to `imsg react` for standard tapbacks. Credentials are provider-aware (`{ provider: "imsg", binaryPath?, region? }`) with no secrets — it relies on macOS Full Disk Access + Automation permissions.

## TypeScript Execution Model

### Local Development

Bun runs TypeScript directly — no compilation step needed.

- `bin` entries in `package.json` point to `./src/*.ts` files
- All CLI entry points use `#!/usr/bin/env bun` shebang
- Run any file: `bun src/cli.ts`
- Run with hot reload: `bun --hot src/cli.ts`

### Production Build (Publish)

`bun run build` compiles to `dist/` for npm consumers who don't have Bun.

1. `tsc` compiles `src/` → `dist/src/` (JS + declarations + source maps)
2. `scripts/copy-vendor.ts` copies the vendored runtime before `tsc-alias` resolves `@/*` paths. A clean build must never depend on old `dist/` bytes.
3. `scripts/postbuild.ts` replaces `#!/usr/bin/env bun` → `#!/usr/bin/env node` in CLI files
4. `module` and `main` in `package.json` point to `dist/cli.js`

npm consumers run compiled JS via Node.js. The `prepublishOnly` script runs the build, then `scripts/prepublish.ts` rewrites `bin` paths from `./src/*.ts` to `dist/src/*.js`. After publish, `postpublish` restores `package.json` via `git checkout`.

### Key Distinction

|             | Local (dev)          | Published (npm)       |
| ----------- | -------------------- | --------------------- |
| Runtime     | Bun                  | Node.js               |
| Entry files | `src/*.ts`           | `dist/src/*.js`       |
| Shebang     | `#!/usr/bin/env bun` | `#!/usr/bin/env node` |
| Compilation | None (Bun runs TS)   | `tsc` → `dist/`       |

## Commands

```bash
bun install     # Install dependencies
bun link        # Link CLI globally for local testing
bun test        # Run unit tests
bun test:e2e    # Run e2e tests
bun typecheck   # Type check without emitting
bun lint        # Lint with oxlint
bun lint:fix    # Lint with oxlint (autofix)
bun format      # Format with oxfmt
```

## Release

Use the **Release** GitHub Actions workflow (`workflow_dispatch`). It typechecks, lints, tests, bumps version in `package.json` / `.claude-plugin/plugin.json` / `README.md` / `skills/*/SKILL.md`, commits, tags, publishes to npm, and creates a GitHub Release. Tags have no `v` prefix.

### Version Decision

- If the user specifies an exact version (e.g., `1.5.0`), use it as-is.
  Otherwise, the agent decides the bump level based on the changes since the last release (never bump major unless user explicitly asks):
  - **minor** — New features, new commands, new platform support, breaking changes
  - **patch** — Bug fixes, refactors, docs, dependency updates, minor improvements
- Never ask the user which version to bump. Decide and proceed.

## Opt-in explicit room read

`KakaoTalkClient.syncReadOnce` reuses the existing `LocoSession.syncMessages` owner once with canonical uint64 `chatId`, `cur=max=target`, and int32 `cnt=0`. A successful header/body with boolean `isOK=true` is applied evidence; false is known not applied; malformed/lost/stale-session results are unknown and never replayed. No link ID is sent. Keep legacy `markRead`/`markReadOnce`, history, authentication lifetime and version/package owners unchanged. Bridge owns durable identity and replay prevention. Synthetic tests do not establish live provider acceptance.
