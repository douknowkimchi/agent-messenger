# agent-messenger

## SER5 SDK40 release gate (2026-11-08)

- Current local candidate: `2.36.1-ser5.40`; installed production remains `2.36.1-ser5.39`.
- The exact source snapshot, proposed unpublished tag, package hashes and Bridge lock live in the external release-candidate manifest and README. Do not copy those changing identities into this source file, because this file is itself part of the package snapshot.
- Clean native build and pack must start without `dist/`. Two independent clean runs must produce the same tgz.
- Vendor runtime copy must run before `tsc-alias`; do not move it back into postbuild or allow stale `dist` to affect alias resolution.
- SDK03 TITLE metadata must be accepted only after successful status, exact room identity and not-left checks. The compiled SDK → actual Bridge/runtime room-list contract must remain covered.
- Local source release readiness does not imply commit, tag, release, install, provider call or live acceptance.

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
2. `scripts/copy-vendor.ts` copies the vendored LINE runtime into `dist/src/vendor`
3. `tsc-alias` resolves `@/*` path aliases only after those runtime targets exist
4. `scripts/postbuild.ts` replaces `#!/usr/bin/env bun` → `#!/usr/bin/env node` in CLI files
5. `module` and `main` in `package.json` point to `dist/cli.js`

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

## SER5 fork integration boundary

This is a SER5 SDK fork, not a request to replace it with upstream main. Read the parent project's existing `donor-update-20261001/RESULT_KO.md#sdk-upstream-integration-20261107` and `webSdkDeltaDisposition20261107` audit entry. Revalidate the consumer pin and ownership; the audited source is SDK39/e0983c88, while this checkout HEAD is83f37d9d.

- User-triggered review only. No scheduled self-merge, automatic promotion, SDK install, account operation or release authority is granted here.
- Reuse pinned original modules with tests and license notices. Keep SER5 history, large-member/olu, open-profile/create/read-state, connection-admission and once contracts until tested equivalents replace them. Do not overwrite whole client/session/listener files.
- Bridge owns policy and durable requests; SDK enforcement must still cover every internal connection and retry. Preserve admission before actual connection, cancellation and unknown/no-resend behavior.
- Exact JSON adoption is recorded in the current roadmap. Keep the single shared parser wrapper and field-specific signed/unsigned validation; do not reintroduce the retired regex or redo accepted same-byte tests.
- Keep idempotent prepublish/type paths until packed-artifact equivalence is proved. Tests and existing KiwiTalk/other notices are not dead code merely because they are non-runtime.
- Current user policy overrides generic CI/release guidance: no CI query/run/wait, no commit/push/PR/deploy from an audit. Reuse unchanged evidence and preserve known failures; source checks are not live acceptance.

- Sync-state storage must retain the existing pre-login failure on malformed JSON. Atomic save does not grant another login, automatic corrupt-state recovery, or cleanup rights over a temp file whose exclusive creation failed. Linux durability and deployed-package acceptance remain distinct from Windows source tests.

- Socket-write completion is not provider acceptance; a missing callback is not proof of non-dispatch. Preserve unknown/no-resend regardless of an optional upstream timeout diagnostic flag. Do not make diagnostic-only upstream types a release prerequisite after the existing timeout-to-terminal contract is verified. Raw-stream deadlines, COMPLETE waits and packet-response timeouts remain separate boundaries.

- Provider role comes from the saved account device_type, not the Windows Client OS. Keep PC default wire fields and booking/checkin/upload paths unchanged when adopting tablet TLS/LOGIN/WRITE defaults. Keep the message-id generator across permitted session reconnects in the client; it is not a replacement for durable Bridge request IDs. Do not regenerate registered UUIDs, expose unrelated login/visibility options, or weaken certificate/name checks as part of this integration. Routing/helper tests, local TLS-option validation and real target-runtime/account acceptance are distinct.
