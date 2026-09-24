import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeStep, JOB_PHRASE } from '../bridge/steps.mjs'

test('a tool call reads as what he is doing, in plain words', () => {
  assert.equal(describeStep('mcp__protective__get_inbox'), 'Reading the Protective inbox')
  assert.equal(describeStep('mcp__protective__get_calendar'), 'Checking the Protective calendar')
  assert.equal(describeStep('mcp__claude_ai_Microsoft_365__outlook_email_search'), 'Searching SCG mail')
  assert.equal(describeStep('mcp__claude_ai_Microsoft_365__outlook_calendar_search'), 'Checking the SCG calendar')
  assert.equal(describeStep('mcp__claude_ai_Gmail__search_threads'), 'Searching Gmail')
  assert.equal(describeStep('mcp__claude_ai_Google_Calendar__list_events'), 'Checking Google Calendar')
  assert.equal(describeStep('mcp__claude_ai_Granola__get_meetings'), 'Reading meeting notes')
  assert.equal(describeStep('WebSearch'), 'Searching the web')
})

test('Confluence is not mistaken for Jira, and JQL is not mistaken for CQL', () => {
  assert.equal(describeStep('mcp__claude_ai_Atlassian_Rovo__searchConfluenceUsingCql'), 'Searching Confluence')
  assert.equal(describeStep('mcp__claude_ai_Atlassian_Rovo__searchJiraIssuesUsingJql'), 'Checking Jira')
  // The same connector added twice carries an id after its name.
  assert.equal(describeStep('mcp__claude_ai_Atlassian_Rovo-a5da3a9d__getJiraIssue'), 'Checking Jira')
})

test('an unknown tool falls back to its service, never a raw identifier', () => {
  assert.equal(describeStep('mcp__claude_ai_Canva__create-design'), 'Using Canva')
  assert.equal(describeStep('mcp__claude_ai_Some_Service-a5da3a9d__do_thing'), 'Using Some Service')
  assert.equal(describeStep('mcp__'), 'Using a tool')
  assert.equal(describeStep(''), 'Working')
  assert.equal(describeStep(undefined), 'Working')
})

test("each background job reports under the badge of the tool that starts it", () => {
  // The page shows a job's steps only when the job's phrase matches the tool
  // badge on screen, so these must stay in step with describeStep.
  assert.equal(JOB_PHRASE.brief, describeStep('mcp__jarvis_brief__get_brief'))
  assert.equal(JOB_PHRASE.wrap, describeStep('mcp__jarvis_loop__get_day_wrap'))
  assert.equal(JOB_PHRASE.dossier, describeStep('mcp__jarvis_loop__get_dossier'))
  assert.equal(JOB_PHRASE['portfolio pulse'], describeStep('mcp__jarvis_portfolio__get_portfolio_pulse'))
  assert.equal(JOB_PHRASE['weekly review'], describeStep('mcp__jarvis_review__get_weekly_review'))
  assert.equal(JOB_PHRASE['commitment scan'], describeStep('mcp__jarvis_loop__scan_commitments'))
})
