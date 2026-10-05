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

/**
 * An email opened in Outlook on the web, or a task in To Do on the web, as
 * bridge/maillinks.mjs builds them for the brief: these hosts, these paths, an
 * encoded id and nothing else.
 */
const MAIL_LINK = /^https:\/\/outlook\.office\.com\/mail\/deeplink\/read\/[A-Za-z0-9%._-]{8,1600}$/
const TODO_LINK = /^https:\/\/to-do\.office\.com\/tasks\/[A-Za-z0-9%._=-]{8,1600}\/details$/

export function isMailLink(url: unknown): url is string {
  return typeof url === 'string' && (MAIL_LINK.test(url) || TODO_LINK.test(url))
}

/**
 * The Jira and Azure DevOps sites the bridge knows (bridge/tickets.mjs), sent
 * in a `sites` frame. Held here so the sanitiser can turn a bare ticket key in
 * a panel into its link.
 */
export type TicketSites = { jira: string | null; ado: string | null }
let known: TicketSites = { jira: null, ado: null }
const SITE = /^https:\/\/(?:[a-z0-9-]+\.atlassian\.net|[a-z0-9-]+\.visualstudio\.com|dev\.azure\.com\/[\w.-]+)$/i

export function setTicketSites(sites: Partial<TicketSites> | null | undefined): void {
  const ok = (s: unknown) => (typeof s === 'string' && SITE.test(s) ? s : null)
  known = { jira: ok(sites?.jira), ado: ok(sites?.ado) }
}

export function ticketSites(): TicketSites {
  return known
}

/**
 * A run of text split into plain text and ticket links.
 *
 * "What's blocked" came back as a list of keys nobody could click: the model
 * was handed each ticket's link and wrote the panel without them. Links no
 * longer depend on it remembering to: any Jira key ("NI-12687") or Azure
 * DevOps id written as "ADO 4567" / "ADO #4567" becomes a link on the known
 * site. Only those shapes, only on those sites, and each link is checked
 * with isTicketLink like any other.
 */
const KEY = /\b([A-Z][A-Z0-9_]{1,15}-\d{1,7})\b|\bADO\s*#?(\d{1,9})\b/g

export type Piece = { text: string; href?: string }

export function linkTicketKeys(text: string, sites: TicketSites = known): Piece[] {
  if (!sites.jira && !sites.ado) return [{ text }]
  const out: Piece[] = []
  let last = 0
  for (const m of text.matchAll(KEY)) {
    const href = m[1]
      ? sites.jira && `${sites.jira}/browse/${m[1]}`
      : sites.ado && `${sites.ado}/_workitems/edit/${m[2]}`
    if (!href || !isTicketLink(href)) continue
    if (m.index > last) out.push({ text: text.slice(last, m.index) })
    out.push({ text: m[0], href })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out.length ? out : [{ text }]
}
