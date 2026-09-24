import type { Alert } from '../store'

/** What each kind of alert is called on its card and in the review list. */
export const LABELS: Record<Alert['kind'], string> = {
  meeting: 'Meeting',
  mail: 'Mail',
  brief: 'Brief',
  wrap: 'Wrap-up',
  review: 'Weekly review',
  reminder: 'Reminder',
  promise: 'Promise',
  portfolio: 'Portfolio',
  digest: 'While you were focused',
}
