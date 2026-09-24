import { readJsonFile, writeJsonFile } from './days.mjs'

/**
 * Links to tickets, so a key on an alert card or a blade opens the ticket.
 *
 * Where the sites are, in order:
 *   1. JARVIS_JIRA_URL / JARVIS_ADO_URL in .env.local
 *      (https://yours.atlassian.net, https://yourorg.visualstudio.com or
 *      https://dev.azure.com/yourorg);
 *   2. what the watcher learned from the Jira connector on its last check,
 *      remembered in ~/.jarvis/ticket-sites.json.
 *
 * A link is only ever built on those hosts, and only from a key or id of the
 * right shape, so nothing a model says can turn into a link somewhere else.
 */

const FILE = 'ticket-sites.json'

/** The site's origin if it is a Jira Cloud or Azure DevOps site, else null. */
export function validSite(u, kind) {
  try {
    const url = new URL(String(u).trim())
    if (url.protocol !== 'https:') return null
    if (kind === 'jira') return /\.atlassian\.net$/i.test(url.hostname) ? url.origin : null
    // Azure DevOps: the org is either the subdomain or the first path segment.
    if (/\.visualstudio\.com$/i.test(url.hostname)) return url.origin
    if (url.hostname.toLowerCase() === 'dev.azure.com') {
      const org = url.pathname.split('/').filter(Boolean)[0]
      return org && /^[\w.-]+$/.test(org) ? `${url.origin}/${org}` : null
    }
    return null
  } catch {
    return null
  }
}

export function ticketSites() {
  const saved = readJsonFile(FILE, {})
  return {
    jira: validSite(process.env.JARVIS_JIRA_URL ?? '', 'jira') ?? validSite(saved.jira ?? '', 'jira'),
    ado: validSite(process.env.JARVIS_ADO_URL ?? '', 'ado') ?? validSite(saved.ado ?? '', 'ado'),
  }
}

/** Remember sites the watcher reported, when they are valid. */
export function learnSites({ jira, ado } = {}) {
  const saved = readJsonFile(FILE, {})
  const next = { ...saved }
  if (validSite(jira ?? '', 'jira')) next.jira = validSite(jira, 'jira')
  if (validSite(ado ?? '', 'ado')) next.ado = validSite(ado, 'ado')
  if (next.jira !== saved.jira || next.ado !== saved.ado) writeJsonFile(FILE, next)
}

const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/
const ADO_ID = /^(?:ADO\s*)?#?(\d{1,9})$/i

/**
 * The link for one item, or null. `key` is a Jira key ("RPT-3880") or an
 * Azure DevOps id ("4567", "#4567", "ADO #4567"); `project` helps an ADO link.
 */
export function ticketUrl({ key, source, project } = {}, sites = ticketSites()) {
  const k = String(key ?? '').trim()
  if (source !== 'ado' && JIRA_KEY.test(k.toUpperCase()) && sites.jira) {
    return `${sites.jira}/browse/${k.toUpperCase()}`
  }
  const id = ADO_ID.exec(k)?.[1]
  if (id && sites.ado && (source === 'ado' || !JIRA_KEY.test(k))) {
    const p = String(project ?? '').trim()
    return p ? `${sites.ado}/${encodeURIComponent(p)}/_workitems/edit/${id}` : `${sites.ado}/_workitems/edit/${id}`
  }
  return null
}
