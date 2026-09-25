/**
 * Formatting for the holdings card (ui/Holdings.tsx), kept pure and import-free
 * so the tests can run it with type stripping.
 *
 * Direction is a glyph, not a colour: red means something broke and amber
 * means something needs him (index.css), and a down day is neither.
 */

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

/** "$12,345.67", or an em dash when the figure was not returned or not verified. */
export function money(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? usd.format(n) : '—'
}

/** "▲ $1,234.56 (+0.85%)", "▼ $12.00 (−0.10%)", "flat", or "—" when unknown. */
export function change(amount: number | null | undefined, pct?: number | null): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—'
  if (Math.abs(amount) < 0.005) return 'flat'
  const up = amount > 0
  const p = typeof pct === 'number' && Number.isFinite(pct) ? ` (${up ? '+' : '−'}${Math.abs(pct).toFixed(2)}%)` : ''
  return `${up ? '▲' : '▼'} ${usd.format(Math.abs(amount))}${p}`
}

/** "just now", "12 min ago", "3 h ago", "Sep 24": how old the figures are. */
export function age(at: number | undefined, now = Date.now()): string {
  if (!at) return ''
  const mins = Math.round((now - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
