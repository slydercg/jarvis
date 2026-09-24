import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A private ~/.jarvis, so learned sites never touch the real one.
process.env.JARVIS_HOME = mkdtempSync(join(tmpdir(), 'jarvis-tickets-'))
delete process.env.JARVIS_JIRA_URL
delete process.env.JARVIS_ADO_URL

const t = await import('../bridge/tickets.mjs')
const { isTicketLink } = await import('../src/lib/tickets.ts')

test('only Jira Cloud and Azure DevOps sites are accepted', () => {
  assert.equal(t.validSite('https://jira456.atlassian.net/jira/software', 'jira'), 'https://jira456.atlassian.net')
  assert.equal(t.validSite('http://jira456.atlassian.net', 'jira'), null, 'https only')
  assert.equal(t.validSite('https://atlassian.net.evil.example', 'jira'), null)
  assert.equal(t.validSite('https://aulcorp.visualstudio.com/Claims', 'ado'), 'https://aulcorp.visualstudio.com')
  assert.equal(t.validSite('https://dev.azure.com/aulcorp/Claims', 'ado'), 'https://dev.azure.com/aulcorp')
  assert.equal(t.validSite('https://example.com', 'ado'), null)
})

test('no link until a site is known; then links from keys of the right shape only', () => {
  assert.equal(t.ticketUrl({ key: 'RPT-3880' }), null)
  t.learnSites({ jira: 'https://jira456.atlassian.net', ado: 'https://evil.example.com' })
  assert.deepEqual(t.ticketSites(), { jira: 'https://jira456.atlassian.net', ado: null })
  assert.equal(t.ticketUrl({ key: 'RPT-3880' }), 'https://jira456.atlassian.net/browse/RPT-3880')
  assert.equal(t.ticketUrl({ key: 'rpt-3144' }), 'https://jira456.atlassian.net/browse/RPT-3144')
  assert.equal(t.ticketUrl({ key: 'RPT-3880/../../x' }), null)
  assert.equal(t.ticketUrl({ key: 'https://evil.example.com/RPT-1' }), null)
  assert.equal(t.ticketUrl({ key: '4567', source: 'ado' }), null, 'no ADO site yet')
})

test('Azure DevOps ids link with or without a project; the setting wins over what was learned', () => {
  process.env.JARVIS_ADO_URL = 'https://aulcorp.visualstudio.com'
  assert.equal(
    t.ticketUrl({ key: 'ADO #4567', source: 'ado', project: 'AULCorp Claims' }),
    'https://aulcorp.visualstudio.com/AULCorp%20Claims/_workitems/edit/4567',
  )
  assert.equal(t.ticketUrl({ key: '#4567' }), 'https://aulcorp.visualstudio.com/_workitems/edit/4567')
  process.env.JARVIS_JIRA_URL = 'https://other.atlassian.net'
  assert.equal(t.ticketUrl({ key: 'NI-812' }), 'https://other.atlassian.net/browse/NI-812')
  delete process.env.JARVIS_JIRA_URL
  delete process.env.JARVIS_ADO_URL
})

test('the page accepts every link the bridge builds, and nothing else', () => {
  for (const url of [
    'https://jira456.atlassian.net/browse/RPT-3880',
    'https://aulcorp.visualstudio.com/AULCorp%20Claims/_workitems/edit/4567',
    'https://aulcorp.visualstudio.com/_workitems/edit/4567',
    'https://dev.azure.com/aulcorp/Claims/_workitems/edit/12',
  ]) {
    assert.equal(isTicketLink(url), true, url)
  }
  for (const url of [
    'http://jira456.atlassian.net/browse/RPT-1',
    'https://jira456.atlassian.net/browse/RPT-1?next=https://evil.example.com',
    'https://jira456.atlassian.net.evil.example.com/browse/RPT-1',
    'https://evil.example.com/browse/RPT-1',
    'javascript:alert(1)',
    'https://jira456.atlassian.net/secure/Dashboard.jspa',
    undefined,
  ]) {
    assert.equal(isTicketLink(url), false, String(url))
  }
})

test('only an Outlook message link of the exact shape counts as a mail link', async () => {
  const { isMailLink } = await import('../src/lib/tickets.ts')
  assert.equal(isMailLink('https://outlook.office.com/mail/deeplink/read/AAMkAGI2TG93AAA%3D%2Fx'), true)
  assert.equal(isMailLink('https://outlook.office.com/mail/deeplink/read/AAMk?redirect=evil.com'), false)
  assert.equal(isMailLink('https://evil.com/mail/deeplink/read/AAMkAGI2TG93'), false)
  assert.equal(isMailLink('http://outlook.office.com/mail/deeplink/read/AAMkAGI2TG93'), false)
  assert.equal(isMailLink('https://outlook.office.com.evil.com/mail/deeplink/read/AAMkAGI2TG93'), false)
})

test('a To Do task link of the exact shape counts too, and nothing near it', async () => {
  const { isMailLink } = await import('../src/lib/tickets.ts')
  assert.equal(isMailLink('https://to-do.office.com/tasks/id/AQMkADAwATM0MDAAMS1h%3D/details'), true)
  assert.equal(isMailLink('https://to-do.office.com/tasks/id/AQMkADAwATM0MDAAMS1h/details?x=1'), false)
  assert.equal(isMailLink('https://to-do.office.com.evil.com/tasks/id/AQMkADAwATM0MDAAMS1h/details'), false)
  assert.equal(isMailLink('https://to-do.office.com/tasks/AQMkADAwATM0MDAAMS1h'), false)
})
