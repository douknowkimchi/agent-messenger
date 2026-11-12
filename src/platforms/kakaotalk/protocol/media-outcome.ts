import { isSyntheticConnectionClose } from './login-response'
import type { LocoPacket } from './types'

// The step a media send had reached. Fixed strings only: they are the one
// diagnostic a caller may log, so they never carry provider or user data.
export type MediaSendPhase =
  | 'ship'
  | 'prepare'
  | 'upload'
  | 'ready'
  | 'write'
  | 'connect'
  | 'post'
  | 'stream'
  | 'complete'

export type MediaStepFailure =
  | 'aborted'
  | 'closed'
  | 'malformed'
  | 'rejected'
  | 'stalled'
  | 'status'
  | 'timeout'
  | 'transport'
  | 'unsupported'

/**
 * One failed media step. It deliberately keeps no cause: a transport error can
 * name a signed upload URL, and a reply can hold a ticket. Whether the message
 * may exist is not decided here; the send owner decides it from how far the
 * attempt had got, never from this message.
 */
export class MediaStepError extends Error {
  readonly phase: MediaSendPhase
  readonly failure: MediaStepFailure
  /** The provider explicitly refused this step, and the refusal created no message. */
  readonly rejected: boolean
  readonly providerStatus: number | null

  constructor(
    phase: MediaSendPhase,
    failure: MediaStepFailure,
    options: { rejected?: boolean; providerStatus?: number | null } = {},
  ) {
    super(`media ${phase} ${failure}`)
    this.name = 'MediaStepError'
    this.phase = phase
    this.failure = failure
    this.rejected = options.rejected === true
    this.providerStatus = options.providerStatus ?? null
  }
}

type LocoStatus = { kind: 'ok' } | { kind: 'rejected'; status: number } | { kind: 'lost' } | { kind: 'malformed' }

// Reads one LOCO answer the way sendTextOnce does: the header and body.status
// must be safe integers, LocoConnection.handleClose's synthetic packet is a
// lost answer rather than a refusal, and any other non-zero status is the
// provider's explicit refusal. handleClose is the only place a packet is
// synthesized locally; a timed-out or unwritten request rejects instead.
function readLocoStatus(response: LocoPacket): LocoStatus {
  if (!Number.isSafeInteger(response.statusCode)) return { kind: 'malformed' }
  if (isSyntheticConnectionClose(response)) return { kind: 'lost' }
  if (response.statusCode !== 0) return { kind: 'rejected', status: response.statusCode }
  const bodyStatus = response.body.status
  if (bodyStatus === undefined) return { kind: 'ok' }
  if (!Number.isSafeInteger(bodyStatus)) return { kind: 'malformed' }
  return bodyStatus === 0 ? { kind: 'ok' } : { kind: 'rejected', status: bodyStatus as number }
}

/**
 * Throws unless `response` is an explicit success.
 *
 * LocoConnection hands a reply to its request by packet id alone. `command`
 * is given only for an answer that is used as evidence of a stored message
 * (WRITEMEDIA, FORWARD, the COMPLETE push): such an answer must also name its
 * command, as the donor's read loop requires of every reply. SHIP, MSHIP, POST
 * and MPOST answers stay matched by packet id alone, as this SDK has always
 * read them; whether the provider echoes their names is not established.
 *
 * The thrown error is `rejected` for an explicit non-zero status. Whether that
 * status proves that no message exists depends on the command; the caller
 * decides.
 */
export function requireLocoOk(response: LocoPacket, phase: MediaSendPhase, command?: string): void {
  const status = readLocoStatus(response)
  if (status.kind === 'lost') throw new MediaStepError(phase, 'closed')
  if (status.kind === 'malformed' || (command !== undefined && response.method !== command)) {
    throw new MediaStepError(phase, 'malformed')
  }
  if (status.kind === 'rejected') {
    throw new MediaStepError(phase, 'rejected', { rejected: true, providerStatus: status.status })
  }
}

/** Whether a reply body names a stored message. */
export function namesStoredMessage(body: Record<string, unknown>): boolean {
  return body.logId !== undefined || body.chatLog !== undefined
}

/**
 * A non-zero status that does not establish whether the message exists: the
 * outcome stays open, and the status is kept only as a diagnostic.
 */
export function openStatus(phase: MediaSendPhase, refusal: MediaStepError): MediaStepError {
  return new MediaStepError(phase, 'status', { providerStatus: refusal.providerStatus })
}
