/**
 * What a tool call is, in the words a person would use: "Reading the
 * Protective inbox", not "protective · protective get inbox".
 *
 * Used for the tool badge while he works, and for the steps a background job
 * (the brief, the wrap-up, the weekly review) reports as it goes — a minute of
 * "thinking" with no sign of progress reads as a hang; "Checking Jira" does
 * not. Tools this does not know fall back to the service's name, so nothing
 * shows as a raw identifier.
 */

/** [server pattern, tool pattern, phrase] — the first match wins. */
const STEPS = [
  // Protective, through Power Automate.
  [/^protective$/, /get_inbox/, 'Reading the Protective inbox'],
  [/^protective$/, /get_calendar/, 'Checking the Protective calendar'],
  [/^protective$/, /get_todo/, 'Reading To Do'],
  [/^protective$/, /get_flagged/, 'Reading flagged mail'],
  [/^protective$/, /get_sent/, 'Reading sent mail'],
  [/^protective$/, /create_draft/, 'Saving a draft'],
  [/^protective$/, /send_email/, 'Sending the email'],
  [/^protective$/, /create_tasks/, 'Adding to To Do'],
  // SCG, through Microsoft 365.
  [/microsoft/, /email_search|get_message|read_resource/, 'Searching SCG mail'],
  [/microsoft/, /calendar_search|find_meeting_availability|find_available_time/, 'Checking the SCG calendar'],
  [/microsoft/, /draft/, 'Drafting in Outlook'],
  [/microsoft/, /send/, 'Sending from Outlook'],
  [/microsoft/, /^teams_/, 'Checking Teams'],
  [/microsoft/, /^sharepoint_/, 'Searching SharePoint'],
  [/microsoft/, /search_people|get_me/, 'Looking up people'],
  // Google.
  [/gmail/, /draft/, 'Drafting in Gmail'],
  [/gmail/, /.*/, 'Searching Gmail'],
  [/google_calendar/, /.*/, 'Checking Google Calendar'],
  [/google_drive/, /.*/, 'Searching Drive'],
  // Meetings and delivery.
  [/granola|wispr/, /.*/, 'Reading meeting notes'],
  [/atlassian|jira/, /confluence|cql/i, 'Searching Confluence'],
  [/atlassian|jira/, /.*/, 'Checking Jira'],
  [/notion/, /.*/, 'Searching Notion'],
  [/hubspot/, /.*/, 'Checking HubSpot'],
  // Jarvis's own jobs.
  [/^jarvis_brief$/, /update_brief_line/, 'Updating your brief'],
  [/^jarvis_brief$/, /.*/, 'Building your brief'],
  [/^jarvis_loop$/, /get_day_wrap/, 'Wrapping up the day'],
  [/^jarvis_loop$/, /get_dossier/, "Looking into who you're meeting"],
  [/^jarvis_loop$/, /scan_commitments/, 'Scanning for promises'],
  [/^jarvis_loop$/, /commitment/, 'Checking your promises'],
  [/^jarvis_portfolio$/, /.*/, 'Checking the portfolio'],
  [/^jarvis_review$/, /.*/, 'Reviewing your week'],
  [/^jarvis_stratum$/, /remind/, 'Setting a reminder'],
  [/^jarvis_stratum$/, /.*/, 'Checking your list'],
  [/^jarvis_focus$/, /.*/, 'Setting focus'],
  [/^jarvis_files$/, /.*/, 'Reading the file'],
  [/^jarvis_chrome$/, /.*/, 'Using your browser'],
  [/^jarvis_eyes$/, /watch/, 'Watching'],
  [/^jarvis_eyes$/, /.*/, 'Looking'],
  [/^jarvis$/, /probe_url/, 'Checking the link'],
  // Markets and money: reading only, unless the gate says otherwise.
  [/robinhood/, /.*/, 'Checking Robinhood'],
  [/alpha_vantage|financial|crypto/, /.*/, 'Checking the markets'],
  [/sonos|spotify/, /.*/, 'Using the speakers'],
]

/** Built-in tools, by name. */
const BUILTIN = {
  WebSearch: 'Searching the web',
  WebFetch: 'Reading a page',
  ToolSearch: 'Getting the right tools',
  Read: 'Reading a file',
  Grep: 'Searching files',
  Glob: 'Looking for files',
  Bash: 'Running a command',
  Write: 'Writing a file',
  Edit: 'Editing a file',
  MultiEdit: 'Editing a file',
  TodoWrite: 'Planning',
  Task: 'Handing off a task',
  Agent: 'Handing off a task',
}

/**
 * "claude_ai_Google_Calendar" -> "Google Calendar". A connector added twice
 * carries an id after its name ("Atlassian_Rovo-a5da3a9d"); that is dropped.
 */
const serviceName = (server) =>
  server
    .replace(/^claude_ai_/i, '')
    .replace(/-[0-9a-f]{6,}$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s*\(\d+\)$/, '')
    .trim()

/**
 * The phrase for one tool name — `mcp__server__tool` or a built-in. Never
 * empty: an unknown tool reads "Using <service>".
 */
export function describeStep(name) {
  const raw = String(name ?? '')
  if (!raw.startsWith('mcp__')) return BUILTIN[raw] ?? (raw ? `Using ${raw}` : 'Working')
  const [, server = '', ...rest] = raw.split('__')
  const key = server.replace(/^claude_ai_/i, '').toLowerCase()
  const tool = rest.join('__')
  for (const [s, t, phrase] of STEPS) {
    if (s.test(key) && t.test(tool)) return phrase
  }
  return `Using ${serviceName(server) || 'a tool'}`
}

/**
 * A background job's name (its askReadOnly label) -> the phrase its tool shows
 * on the badge, so the page puts a job's steps under that job's badge and no
 * other one.
 */
export const JOB_PHRASE = {
  brief: 'Building your brief',
  wrap: 'Wrapping up the day',
  dossier: "Looking into who you're meeting",
  'portfolio pulse': 'Checking the portfolio',
  'weekly review': 'Reviewing your week',
  'commitment scan': 'Scanning for promises',
}
