/**
 * Today's brief for the evals, as the brief builder would have saved it:
 * built half an hour ago from the fake Protective account (fake-protective.mjs).
 * One line was already replied to, so the evals can check a done line never
 * makes the three he shows.
 */
export function briefFixture(now = new Date()) {
  const received = (h, m = 0) => {
    const d = new Date(now)
    d.setHours(h, m, 0, 0)
    return d.toISOString()
  }
  return {
    day: now.toLocaleDateString('en-CA'),
    builtAt: now.getTime() - 30 * 60_000,
    brief: {
      focus: 'Sign off the Northwind contract for Dana before three; then the board roadmap and Chris on Thursday.',
      items: [
        {
          priority: 'now', account: 'Protective', who: 'Dana Whitfield', action: 'Sign off the Northwind vendor contract',
          why: 'Pricing lapses at 3pm', source: 'email', from: 'dana.whitfield@example.com',
          subject: 'Need your sign-off on the vendor contract today', received: received(8, 12), messageId: 'm-urgent',
        },
        {
          priority: 'now', account: 'Protective', who: 'CFO', action: 'Approve the Datadog renewal',
          why: 'Renewal window closes Friday', source: 'email', from: 'cfo@example.com',
          subject: 'Datadog renewal', received: received(7, 5), done: 'replied',
        },
        {
          priority: 'now', account: 'Protective', who: 'Tasks', action: 'Send the Q4 roadmap to the board',
          why: 'Board pack goes out tomorrow', source: 'task', from: 'Tasks', subject: 'Send Q4 roadmap to the board',
        },
        {
          priority: 'soon', account: 'Protective', who: 'Chris Okafor', action: "Confirm Thursday's architecture review",
          why: 'He is waiting on a yes', source: 'email', from: 'chris.okafor@example.com', subject: 'Thursday?',
          received: received(9, 2), messageId: 'm-chris',
        },
      ],
      meetings: [],
      sources: { protective: 'ok', scg: 'none', todo: 'ok', google: 'none' },
    },
  }
}
