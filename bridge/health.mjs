/**
 * Background work that keeps failing, said out loud once.
 *
 * The calendar, mail and portfolio checks, and the commitment scan, used to
 * fail into the log and nowhere else: a revoked connector or a broken flow
 * meant meeting heads-ups and mail alerts simply stopped, and the only sign
 * was their absence. Now each job's consecutive failures are counted, and the
 * user is told once when one reaches the threshold — not on every failure,
 * which would turn a flaky afternoon into a stream of apologies. A success
 * resets the count, and a job that recovers after being reported can be told
 * again if it breaks again.
 *
 *   threshold  failures in a row before saying anything (default 3)
 *   onStuck    (job, count, reason) => void, called once per outage
 */
export function createStreaks({ threshold = 3, onStuck } = {}) {
  const streak = new Map()
  const told = new Set()
  return {
    ok(job) {
      streak.delete(job)
      told.delete(job)
    },
    fail(job, reason = '') {
      const n = (streak.get(job) ?? 0) + 1
      streak.set(job, n)
      if (n >= threshold && !told.has(job)) {
        told.add(job)
        onStuck?.(job, n, reason)
      }
      return n
    },
    count: (job) => streak.get(job) ?? 0,
  }
}

/** What the user hears about a job that keeps failing. */
const SPOKEN = {
  calendar: 'your calendar',
  mail: 'your mail',
  portfolio: 'the portfolio',
  commitments: 'your promises and follow-ups',
  watcher: 'your calendar and mail',
  voice: 'your sent mail to learn how you write',
}

/** An alert card and line for a job that has failed `count` times running. */
export function stuckAlert(job, count, reason = '') {
  const what = SPOKEN[job] ?? job
  return {
    kind: 'reminder',
    title: `Can't check ${what}`,
    detail:
      `${count} checks in a row have failed${reason ? ` (${reason})` : ''}. ` +
      'Details are in ~/.jarvis/logs/jarvis.log. A connector may need signing in again at claude.ai → Settings → Connectors.',
    say: `Sir, I haven't been able to check ${what} for a while. A connector may need signing in again.`,
    at: new Date().toISOString(),
  }
}
