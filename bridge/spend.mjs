import { localDay, readJsonFile, writeJsonFile } from './days.mjs'

/**
 * What he costs: every model turn's spend, added up by day and by kind, in
 * ~/.jarvis/spend.json, for the Diagnostics panel and the optional daily cap.
 *
 * The figures are the SDK's total_cost_usd, which is an estimate at API prices
 * even on a subscription: good for "which part costs what" and "is today
 * unusual", not a bill.
 *
 * Kinds: "conversation" (what you asked), "background" (brief, wrap, dossier,
 * pulse, review, promise scan) and "watcher" (the alert checks).
 *
 * JARVIS_DAILY_CAP_USD, when set, pauses the work nobody asked for (the
 * watcher's checks, the morning brief offer, the evening wrap and Friday
 * review offers, the promise scan) once today's total reaches it. He still
 * answers when asked: a cap that silenced him mid-question would be worse
 * than the spend.
 */

const SPEND_FILE = 'spend.json'
/** Days kept: enough for "this month" at a glance. */
const KEEP_DAYS = 35
export const KINDS = ['conversation', 'background', 'watcher']

const round = (n) => Math.round(n * 10_000) / 10_000

export function dailyCap() {
  const n = Number(process.env.JARVIS_DAILY_CAP_USD)
  return Number.isFinite(n) && n > 0 ? n : null
}

let onCap = () => {}
/** Called once a day, the first time the cap is reached. */
export function onCapReached(fn) {
  onCap = fn
}

/** Add one turn's cost. Zero, negative or nonsense amounts are ignored. */
export function recordSpend(kind, usd, now = new Date()) {
  const amount = Number(usd)
  if (!Number.isFinite(amount) || amount <= 0 || !KINDS.includes(kind)) return
  const day = localDay(now)
  const saved = readJsonFile(SPEND_FILE, {})
  const days = saved.days && typeof saved.days === 'object' ? saved.days : {}
  const before = total(days[day])
  days[day] = { ...days[day], [kind]: round((days[day]?.[kind] ?? 0) + amount) }
  const oldest = localDay(new Date(now.getTime() - KEEP_DAYS * 86_400_000))
  for (const d of Object.keys(days)) if (d < oldest) delete days[d]
  const cap = dailyCap()
  const crossed = cap !== null && before < cap && total(days[day]) >= cap && saved.capped !== day
  writeJsonFile(SPEND_FILE, { ...saved, days, ...(crossed ? { capped: day } : {}) })
  if (crossed) {
    console.warn(`[jarvis] spend: today's $${total(days[day]).toFixed(2)} reached the $${cap.toFixed(2)} cap; background work paused until tomorrow`)
    try {
      onCap(total(days[day]), cap)
    } catch {
      // Telling him is a courtesy; the pause holds either way.
    }
  }
}

function total(day) {
  return round(KINDS.reduce((sum, k) => sum + (Number(day?.[k]) || 0), 0))
}

/** True once today's spend has reached the cap: skip work nobody asked for. */
export function backgroundPaused(now = new Date()) {
  const cap = dailyCap()
  if (cap === null) return false
  return total(readJsonFile(SPEND_FILE, {}).days?.[localDay(now)]) >= cap
}

/**
 * Today, the last seven days and the last thirty, each split by kind, plus the
 * cap and whether it has paused anything.
 */
export function spendSummary(now = new Date()) {
  const days = readJsonFile(SPEND_FILE, {}).days ?? {}
  const span = (n) => {
    const from = localDay(new Date(now.getTime() - (n - 1) * 86_400_000))
    const byKind = Object.fromEntries(KINDS.map((k) => [k, 0]))
    for (const [d, v] of Object.entries(days)) {
      if (d < from || d > localDay(now)) continue
      for (const k of KINDS) byKind[k] = round(byKind[k] + (Number(v?.[k]) || 0))
    }
    return { total: total(byKind), byKind }
  }
  const cap = dailyCap()
  const today = span(1)
  return { today, week: span(7), month: span(30), cap, paused: cap !== null && today.total >= cap }
}
