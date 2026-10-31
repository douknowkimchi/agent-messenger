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
