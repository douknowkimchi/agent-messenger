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

`getChatReadStateOnce` reads CHATINFO only on the already present SDK session. It must not acquire a session, connect, replay, or accept a late response after session replacement/close/cancellation. It shares the legacy reader's response decoder; legacy `getChatReadState` keeps its existing acquisition behavior. This observation alone does not prove an applied read target or retire a durable unknown command.

`KakaoTalkClient.syncReadOnce` reuses the existing `LocoSession.syncMessages` owner once with canonical uint64 `chatId`, `cur=max=target`, and int32 `cnt=0`. A successful header/body with boolean `isOK=true` is applied evidence; false is known not applied; malformed/lost/stale-session results are unknown and never replayed. No link ID is sent. Keep legacy `markRead`/`markReadOnce`, history, authentication lifetime and version/package owners unchanged. Bridge owns durable identity and replay prevention. Synthetic tests do not establish live provider acceptance.

`getOpenRoomIdentityOnce` reads an existing open room through the existing CHATINFO/GETMEM/INFOLINK parsers on one captured ready session (at most eight packets). It never acquires, reconnects, JOINs or marks read; every await fences cancellation and replacement. Legacy readers keep their existing behavior.

`getRecentMessagesReadOnlyOnce` is the opt-in room-opening history owner: reuse existing MCHATLOGS parsing on one captured session with four-page maximum; no SYNCMSG/CHATONROOM/NOTIREAD fallback, no acquire/reconnect. An unproved suffix remains unavailable. `getChatOnce` and `getMemberSnapshotOnce` reuse the current snapshot decoders without session acquisition. Legacy history repair consumers are unchanged.

## Media send result contract

`sendPhoto`, `sendVideo`, `sendAudio`, `sendFile` and `sendMultiPhoto` report one fixed contract; consumers rely on these names. A registered message returns `{ success: true, status_code: 0, chat_id, log_id, sent_at }`. An explicit provider refusal that created no message returns `{ success: false, status_code: <provider status>, log_id: "0", sent_at: 0 }`. A failure before anything that can create the message throws `KakaoTalkError` with `code === 'media_not_dispatched'`. The requests that can create the message are a single upload's POST (the server may answer with COMPLETE alone), WRITEMEDIA and the album's FORWARD; an album's MPOST cannot. After such a request, anything short of a consistent success throws the method's existing `send_*_failed` code and is outcome-unknown, never `success: false`. The only refusals returned after it are an explicit non-zero POST or COMPLETE status that names no stored message; a non-zero WRITEMEDIA or FORWARD status is unknown and carried in `providerStatus`. An answer used as evidence of a stored message (WRITEMEDIA, FORWARD, the COMPLETE push) must name its own command; SHIP, MSHIP, POST and MPOST answers are matched by packet id alone, as before. WRITEMEDIA success needs the chat id, a positive log id and a positive `sendAt`; COMPLETE and FORWARD need the log id, as before. In all three, every chat id the answer states (its own or its chatLog's) must be the request's chat and every log id it states must agree, else the outcome is unknown. Every throw carries only `phase` and `providerStatus`; no cause, token, URL, file name or room. Classify from how far the attempt got (`MediaSendAttempt.registrationAttempted` in `media-send.ts`), never from error text.

`executeWithReconnect` still reruns a send whose session died before a registration request; after one, the rerun dispatches nothing and the send stays unknown. A SHIP answered `rd: true` uses the HTTP path in `protocol/media-direct.ts` (prepare → Kage chunks → ready poll → one WRITEMEDIA), adapted from frrad/mooo (see `protocol/NOTICE.md`): Kage (`vk`) only, for photo, video and file. The signed upload URL never receives account headers. The trailer path still sends the file as one secure frame (multi-frame uploads are unobserved from this SDK); the stall limit is progress-based, applied to 8192-byte socket writes of that frame, and the COMPLETE wait counts from the last byte. `close()` ends an HTTP upload before its WRITEMEDIA; a trailer upload finishes on its own media connection as before. Synthetic tests do not establish live provider acceptance of either path.
