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

## mooo SHIP-redirect media upload adaptation (2026-11-12)

- Source: https://github.com/frrad/mooo
- Exact commit: `a638e2447677510ba31766cfae35863b57487550`
- License: MIT, Copyright (c) 2026 Frederick. The full license text is kept
  at the top of `media-direct.ts`, which ships with the build.
- Files adapted (Go to TypeScript, modified):
  - `internal/protocol/media/direct.go`, `internal/protocol/media/directphoto.go`
    and `internal/client/media_direct.go` into `media-direct.ts` and the
    redirect branch of `../media-send.ts`;
  - the stall limit and COMPLETE wait of `internal/client/media.go` into
    `media-uploader.ts` (its 4096-byte framing was not adopted);
  - the duplicate-key rule of `internal/protocol/strictjson` into
    `media-direct.ts`, checked for every nested object as well.
- Protocol references read: `research/bridge/SHIP-REDIRECT.md`,
  `research/bridge/SHIP-REDIRECT-FILE-VIDEO.md`,
  `research/media-upload-stream.md`, `research/web-error-bodies.md`.

Disposition: **BEHAVIOR_PORT**. A SHIP answered `rd: true` no longer dials the
trailer endpoint: the existing session, account REST headers and
`LocoConnection` are reused for prepare, the chunked Kage upload, the ready
poll and one WRITEMEDIA. No new LOCO connection type, authentication or
encryption was imported. The donor was not executed here, and none of this was
run against the provider from this SDK.

Deliberate differences:

- Identity. The donor sends the Mac profile. This SDK sends its own account
  REST headers (the tablet's `android/...` `A` and `User-Agent` in production)
  and `talk-agent: <LOCO os>/<app version>`; only the Mac form `macos/...` is
  the donor's. The donor's research names both official clients for the
  endpoints and bodies, but the Android header values are unconfirmed.
- Requests. The chat id is written into the JSON body digit for digit, since it
  can exceed 2^53. An answer with repeated keys in any object is refused, as in the
  donor; its size, depth and trailing-data limits are left to `JSON.parse` and
  the 1 MiB body bound. Node's `fetch` is used with `redirect: 'manual'`; it
  keeps no cookie jar. A Kage chunk is given to `fetch` as a stream with its
  exact `Content-Length`, which sends the same bytes and headers as a buffer.
- Time bounds. The donor relies on the caller's context. Here each prepare or
  ready request ends after 20 s. A Kage chunk ends after 10 s without `fetch`
  taking its next 16 KiB, or 120 s after the last one without an answer. The
  ready poll keeps the donor's 5 s default interval and 600 s cap, measured on
  the monotonic clock; later answers can only shorten that deadline. No request
  or sleep outlasts it, and an answer at or after it is not acted on, including
  READY_DONE. All of these end before WRITEMEDIA.
- Refusals. A non-2xx answer is a refusal when its JSON body carries a short
  digit `code` (the content filter's `90025`) or an integer `status`, or when
  the HTTP status is 4xx; that number is reported. A redirect or a 5xx without
  such a body is a failed request. Both end before WRITEMEDIA.
- Scope. Kage (`vk`) only, as in the donor: a Tenth or unchunked ticket stops
  before any byte is uploaded. Photo, video and file only: audio has no traced
  HTTP form, and albums (MSHIP) keep the trailer path. No caption is sent,
  because this SDK's media sends carry none. Photos accept every image type
  the SDK already sends (the donor accepts JPEG and PNG).
- Trailer stream. The donor streams 4096-byte frames, as its research says
  the official Mac client does (8192 on Android), and records that no such
  upload from a third-party client has been observed. This SDK keeps the one
  whole-file frame it has always sent, the only framing observed from it
  against the provider. The stall limit is applied below the framing: that
  frame is handed to the socket 8192 bytes at a time.
- Outcome. The donor returns Go errors; this SDK maps the same boundaries to
  its result contract (`AGENTS.md`, "Media send result contract"), with these
  differences. A single upload is treated as open from its POST, since the
  server can answer with COMPLETE alone. An explicit non-zero POST or COMPLETE
  status is a refusal, as the donor's research classifies it, unless the same
  answer names a stored message. An answer used as evidence of a stored
  message (WRITEMEDIA, FORWARD, the COMPLETE push) must carry its command
  name, as the donor's read loop requires of every reply, and every chat id
  and log id it states must agree; SHIP, MSHIP, POST and MPOST answers stay
  matched by packet id alone, as this SDK has always read them. A non-zero
  WRITEMEDIA status is
  left outcome-unknown: the donor's bridge reports any status reply as a
  refusal, but its research calls a failed WRITEMEDIA reply ambiguous and
  names no status that proves nothing was stored.
