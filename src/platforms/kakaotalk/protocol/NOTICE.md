# Third-Party Notices

This KakaoTalk protocol and Android authentication implementation was written
from scratch for agent-messenger. The protocol knowledge used to build it comes
from the following open-source projects and their documentation. The original protocol implementation did not copy code from these projects.
The later, specifically identified KiwiTalk history behavior adaptation below
is an exception; it does not replace the original authentication or transport.

---

## openkakao

- Repository: https://github.com/JungHoonGhae/openkakao
- License: MIT
- Copyright (c) 2025 JungHoonGhae

Primary protocol reference for: current encryption parameters (AES-128-GCM,
key_encrypt_type=16, encrypt_type=3), RSA public key (PKCS#1, e=3), connection
flow (Booking → Checkin → Login), packet structure, LOCO command reference,
macOS credential extraction approach, and LOGINLIST field schema.

---

## loco-wrapper

- Repository: https://github.com/NetRiceCake/loco-wrapper
- License: No license specified
- Note: Referenced for protocol behavior only; no code adapted.

Referenced for: LOGINLIST packet field names and BSON types (LoginListOut.java),
Android sub-device login flow, and connection patterns.

---

## node-kakao

- Repository: https://github.com/storycraft/node-kakao
- License: MIT
- Copyright (c) 2020 storycraft

Referenced for: LOCO packet format, BSON command schemas, authentication flow,
Android OAuth refresh request/response behavior, X-VC signature algorithm,
channel/chat type enumerations.

---

## KakaoForge

- Repository: https://github.com/play2fly/KakaoForge
- Reference commit: 4b774ea40b1347280fadb685415436584093118b
- License: KakaoForge Non-Commercial / No Abuse License
- Copyright (c) 2026 aodjo

Referenced for: current Android `oauth2_token.json` request fields, client
headers, device-id handling, and token rotation/expiry response fields. Protocol
behavior only; no source code was copied or adapted.

---

## Original LOCO Protocol Research

- Author: Cai (bpak.org)
- URL: http://www.bpak.org/blog/tag/loco/
- Date: 2012-2013

The foundational reverse engineering of the LOCO protocol that all subsequent
implementations are based on.


---

## KiwiTalk incremental history behavior adaptation (2026-10-29)

- Source: https://github.com/dlwltkd/kiwitalk
- Exact commit: `912528b6407a02a1f9b17cbc6fa3331497e6cabc`
- File: `backend/crates/headless-talk/src/updater/chat.rs`
- Git blob: `b58ce5d175d703af5e334b5aa0529cf4f1c3a5f8`
- License: Apache-2.0; original license and NOTICE are preserved under
  `src/vendor/kiwitalk-history/` and copied by the existing postbuild vendor step.
- Original project: KiwiTalk/KiwiTalk; authors: KiwiTalk contributors;
  revival-fork maintainer: dlwltkd. The original NOTICE remains authoritative.

Disposition: **BEHAVIOR_PORT**. The existing TypeScript `getMessages` and
`validatedHistoryRows` adapt the donor's `apply_sync_page`/`update_forward`
page-admission and monotonic-progress rules. The corresponding empty, overlap,
terminal-gap and wrong-room regression scenarios are adapted in
`client-message-history.test.ts`. These are modified adaptations, not a verbatim
copy of the Rust runtime or a claim that the donor was executed here.

Deliberate differences: accepted progress lasts only for the current SDK call
in RAM; no SQLite, disk checkpoint, cross-call cache, new login, room entry,
GETMSGS recovery, or native read acknowledgement was imported. Existing eligible
same-session MCHATLOGS-to-SYNCMSG fallback and existing page budgets are retained.
The forward page ends at `isOK`, as the donor's `sync_chat_stream` and the
production SDK18 reader do: on the real provider every startup interval answered
`isOK` before CHATINFO's lastLogId, so 2.36.1-ser5.22's target-required forward
completion rejected all of them. The held count stays zero (the donor's Android
probe sends 50; the held-count reading of `cnt` remains an external observation,
unverified on this account). The recent reader keeps its stricter suffix proof.
Explicit provider denial, invalid page and no-progress errors stop instead of
being recast as permission to try another protocol. An empty bulk tail requires
the existing fresh CHATINFO target check before its retained prefix can be
reported as current. Original native-ID, formatting, session and transport
owners are reused. This does not establish Android/OpenChat live compatibility
or the absence of SYNCMSG read effects.

Successful omitted/null bulk chatLogs are normalized to an empty collection,
as in the pinned Android response model. They still require the existing fresh
target check and never erase a validated prefix or normalize provider refusal.

---

## Agent Messenger exact JSON module adoption (2026-11-07)

- Source: `agent-messenger/agent-messenger@f33e71014523c0577b6165dbf3c45e261d84cace` (2.42.0).
- Files: `src/platforms/kakaotalk/protocol/exact-json.ts` and `exact-json.test.ts`.
- License: MIT; Copyright (c) 2026 Jeon Suyeol. The exact upstream grant is
  preserved in the repository root `LICENSE`; existing donor notices still apply.
- Disposition: direct module/test adoption with a narrow syntax correction.
  Quoting an unsafe integer must not turn an invalid unquoted object key into
  valid JSON; the local correction rejects that case and retains its regression.
- Only `parseJsonPreservingIntegers` is connected to the existing single
  `parseAttachmentJson` owner used by history and push. The former top-level
  `src_logId` regex repair is retired. The upstream signed-ID serializer and
  Long-like normalization are not connected to production send/read validation;
  existing field-specific signed/unsigned and 32-bit-part checks remain owners.


---

## Agent Messenger sync-state and room-list adoption (2026-11-07)

- Source: `agent-messenger/agent-messenger@f33e71014523c0577b6165dbf3c45e261d84cace` (2.42.0), MIT.
- SDK02 reuses the atomic-save implementation and save tests from
  `sync-state-store.ts` / `sync-state-store.test.ts`. The existing SER5 load
  validation is retained: malformed JSON remains an error before login, and
  its bytes stay in place. The donor's quarantine-and-continue policy is not
  enabled. Existing Bridge admission and discard-before-login remain owners.
- Temporary-file cleanup is non-force and only follows successful exclusive
  creation. Save and cleanup failures are both retained. SDK source tests
  cover existing-file collisions and cleanup failure in addition to the
  donor's write, sync, rename, and serialization scenarios. POSIX permissions
  and directory fsync still need the relevant Linux acceptance.
- SDK03 reuses `cursorToLong`, zero-cursor full-list paging,
  `getTitleOpenLinkId`, the numeric/nonzero link normalization, title fallback,
  and their direct tests from `client.ts` / `client.test.ts`.
- The new CHATINFO-to-title fallback additionally uses existing response,
  same-room, exact-ID, and left-state checks. Existing TITLE/snapshot fallback,
  deduplication, page cap, Bridge room cap, and session fences are unchanged.
- No TLS, protocol send, retry policy, moderation, schema, live account action,
  dependency pin, or SDK release version is changed by this candidate.


---

## Agent Messenger text/reply delivery integration

- Source: `agent-messenger/agent-messenger@f33e71014523c0577b6165dbf3c45e261d84cace` (2.42.0), MIT; the upstream grant remains in the root `LICENSE`.
- The existing `executeWithReconnect` adopts the upstream per-operation
  `retryOnDisconnect` boundary. Plain text and quoted replies disable replay;
  read-only operations retain the existing default reconnect behavior. The
  upstream `retryUnknownDelivery` opt-in is deliberately not adopted.
- The upstream `formatSendResult` is not copied: it returns `success:false`
  for malformed acknowledgements, which the current Bridge treats as definite
  rejection. Instead, the existing stricter SER5 `sendTextOnce` status and
  exact-ID checks are shared with `sendMessage` through one acknowledgement
  reader. Explicit provider refusals return false; missing/malformed identity,
  synthetic connection close, and other uncertain failures remain exceptions.
- The prepared-session `sendTextOnce` API, reply source validation, connection
  admission, and Bridge durable reservation/no-replay contracts are preserved.
  Shared reconnect tests now use a retryable list read, while separate text
  tests verify that a write is never replayed on a replacement session.
- Attachment completion, multi-photo dispatch, packet timeout/write tracking,
  TLS/device-role changes, package pins, and live release are not part of this
  bounded text/reply integration. No new sending engine is introduced.

---

## Agent Messenger media completion integration (2026-11-08)

- Reference: `agent-messenger/agent-messenger@f33e71014523c0577b6165dbf3c45e261d84cace`
  (MIT, existing root LICENSE). Reuse its per-operation no-replay boundary and
  single-media COMPLETE handling in the existing client, with SER5's stricter
  status and exact acknowledgement identity owner shared with text/replies.
- Missing/malformed completion and lost responses are unknown exceptions, not
  synthetic success or definitive rejection. Explicit SHIP/MSHIP and final
  message refusals keep their distinct result; partial item failures remain
  conservative until the final grouped-message acknowledgement exists.
- Grouped uploads settle every started sibling, inspect each completion, and
  do not FORWARD when any item is uncertain or the original session changed.
  Existing Bridge copies and durable command ownership are retained.
- Narrow corrections to the existing uploader validate POST/MPOST admission
  and resume offset before raw bytes, include connect in resource cleanup, and
  release a missing COMPLETE wait when that upload connection closes. These
  are local corrections, not a new protocol, TLS, authentication or retry engine.
- Built-contract tests use actual compiled SDK/uploader and actual Bridge
  command/state owners with synthetic provider sessions/socket methods only.
  They do not establish real provider acceptance, packet-timeout `written`
  telemetry, TLS migration, actual process restart or deployed-package parity.

---

## Agent Messenger tablet role and TLS integration (2026-11-08)

- Source: `agent-messenger/agent-messenger@f33e71014523c0577b6165dbf3c45e261d84cace`
  (2.42.0), MIT; Copyright (c) 2026 Jeon Suyeol. The grant is preserved in
  the root `LICENSE`.
- Reused units: role-specific TLS options in `protocol/config.ts`,
  `protocol/message-id.ts` and its tests, and tablet LOGINLIST/WRITE defaults
  in the existing session owner. Local tests cover the adopted role boundary.
- SER5 adaptations retain PC legacy transport and wire fields, force certificate
  and service-name verification, and keep one message-id generator in the client
  across admitted reconnects. Registered UUIDs, admission, once/no-replay,
  FORWARD and POST/MPOST owners remain unchanged.
- The precise TLS offer is selected only for its measured runtime profile;
  other runtimes use the upstream fallback options. Local secure-context and
  synthetic role tests do not establish a real TLS handshake or account login.
