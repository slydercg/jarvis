/**
 * Whether a URL is a link to a ticket — a Jira Cloud issue or an Azure DevOps
 * work item — and nothing else.
 *
 * The one kind of link the interface renders. Alert cards and blades are
 * otherwise not clickable (see ui/sanitise.ts): a model-authored page that
 * could link anywhere is a phishing surface, but "open RPT-3880" is the whole
 * point of showing a ticket key. The bridge builds these from known sites
 * (bridge/tickets.mjs); this is the page's own check on top.
 *
 * Kept import-free so tests can run it with type stripping.
 */
const TICKET_LINK =
  /^https:\/\/(?:[a-z0-9-]+\.atlassian\.net\/browse\/[A-Z][A-Z0-9_]+-\d+|[a-z0-9-]+\.visualstudio\.com\/(?:[^/?#]+\/)?_workitems\/edit\/\d+|dev\.azure\.com\/[\w.-]+\/(?:[^/?#]+\/)?_workitems\/edit\/\d+)$/i

export function isTicketLink(url: unknown): url is string {
  return typeof url === 'string' && TICKET_LINK.test(url)
}
