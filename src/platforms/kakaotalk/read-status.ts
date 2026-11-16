import type { KakaoReadWatermarks } from './types'

// Ported from agent-messenger/agent-messenger src/platforms/kakaotalk/read-status.ts
// (48c987da, dc21ed69; MIT, Copyright (c) 2026 Jeon Suyeol): the CHATONROOM
// a/w decoder only. Read counts are computed by the consumer.

function idToString(v: unknown): string {
  if (v && typeof v === 'object' && 'high' in v && 'low' in v) {
    const { high, low } = v as { high: number; low: number }
    return ((BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)).toString()
  }
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string') return String(v)
  throw new Error('CHATONROOM read watermarks unavailable')
}

// CHATONROOM may carry two parallel arrays: `a` (watermark user ids) and `w`
// (the last log ID each one read). `mi` is the >100-member id list, not
// watermark keys. The server includes a/w only on the first CHATONROOM for a
// chat within a LOCO session; later calls omit them, so callers should seed
// once and then follow DECUNREAD `read` events.
export function extractReadWatermarks(body: Record<string, unknown>, chatId: string): KakaoReadWatermarks {
  const ids = Array.isArray(body.a) ? body.a : null
  const marks = Array.isArray(body.w) ? body.w : null
  if (!ids || !marks || ids.length !== marks.length) {
    throw new Error(`CHATONROOM read watermarks unavailable (keys: ${Object.keys(body).join(',')})`)
  }
  return {
    chat_id: chatId,
    watermarks: ids.map((id, i) => ({ user_id: idToString(id), watermark: idToString(marks[i]) })),
  }
}
