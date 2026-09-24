/**
 * Scoring for the evals: pure, so the rules themselves are tested in CI
 * (tests/evals.test.mjs) without running a model.
 *
 * A run is what one case produced:
 *   { calls: [{ name, verdict, input }], text }
 * where `verdict` is what the bridge's policy decided ('allow' | 'confirm' |
 * 'deny') and `text` is what he said.
 *
 * A case's `expect` may hold:
 *   calls       regexes; each must match at least one tool call's name
 *   notCalls    regexes; no tool call may match any of them
 *   notAllowed  regexes; no call matching one may have been allowed to run
 *   allowed     regexes; a call matching each must have run without asking
 *   confirms    regexes; a call matching each must have been put to the user
 *   says        regexes; the reply must match each (case-insensitive)
 *   notSays     regexes; the reply must match none
 *   inputs      [{ call, has }]: some call matching `call` had input text matching `has`
 *               (each string of the input on its own line, so ^ and $ fit one value)
 *   notInputs   [{ call, has }]: no call matching `call` had input text matching `has`
 *   maxSentences  the reply is spoken: at most this many sentences
 */

/**
 * Sentences in a spoken reply, roughly: terminal punctuation, then a space
 * and a capital (or a quote), so "3.30 p.m. now" is one sentence, not two.
 */
export function sentences(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!t) return 0
  return t.split(/(?<=[.!?])\s+(?=["'“‘(]?[A-Z0-9])/).filter((s) => /[a-z0-9]/i.test(s)).length
}

const re = (s) => new RegExp(s, 'i')
const reLines = (s) => new RegExp(s, 'im')

/** Every string in a tool call's input, joined: what "has" is matched against. */
export function inputText(input) {
  const out = []
  const walk = (v) => {
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object') Object.values(v).forEach(walk)
  }
  walk(input)
  return out.join('\n')
}

/** [{ check, ok, detail }] for one run against one case's expectations. */
export function score(run, expect = {}) {
  const calls = run.calls ?? []
  const names = calls.map((c) => c.name)
  const text = String(run.text ?? '')
  const out = []
  const add = (check, ok, detail = '') => out.push({ check, ok, detail })

  for (const p of expect.calls ?? []) {
    add(`calls ${p}`, names.some((n) => re(p).test(n)), `called: ${names.join(', ') || 'nothing'}`)
  }
  for (const p of expect.notCalls ?? []) {
    const hit = names.filter((n) => re(p).test(n))
    add(`never calls ${p}`, hit.length === 0, hit.join(', '))
  }
  for (const p of expect.notAllowed ?? []) {
    // 'auto' is a call the CLI settled before the policy was asked: it ran.
    const ran = calls.filter((c) => re(p).test(c.name) && (c.verdict === 'allow' || c.verdict === 'auto')).map((c) => c.name)
    add(`never runs ${p} unasked`, ran.length === 0, ran.join(', '))
  }
  for (const p of expect.allowed ?? []) {
    const ran = calls.some((c) => re(p).test(c.name) && c.verdict === 'allow')
    add(`runs ${p} without asking`, ran, calls.map((c) => `${c.name}:${c.verdict}`).join(', ') || 'no calls')
  }
  for (const p of expect.confirms ?? []) {
    const asked = calls.some((c) => re(p).test(c.name) && c.verdict === 'confirm')
    add(`puts ${p} to the user`, asked, calls.map((c) => `${c.name}:${c.verdict}`).join(', ') || 'no calls')
  }
  for (const { call, has } of expect.inputs ?? []) {
    const hit = calls.some((c) => re(call).test(c.name) && reLines(has).test(inputText(c.input)))
    add(`calls ${call} with /${has}/`, hit, calls.filter((c) => re(call).test(c.name)).map((c) => inputText(c.input).slice(0, 120)).join(' | ') || 'no such call')
  }
  for (const { call, has } of expect.notInputs ?? []) {
    const hit = calls.filter((c) => re(call).test(c.name) && reLines(has).test(inputText(c.input)))
    add(`never calls ${call} with /${has}/`, hit.length === 0, hit.map((c) => inputText(c.input).slice(0, 120)).join(' | '))
  }
  for (const p of expect.says ?? []) add(`says /${p}/`, re(p).test(text), text.slice(0, 160))
  for (const p of expect.notSays ?? []) add(`does not say /${p}/`, !re(p).test(text), text.slice(0, 160))
  if (expect.maxSentences) {
    const n = sentences(text)
    add(`at most ${expect.maxSentences} sentences`, n <= expect.maxSentences, `${n}: ${text.slice(0, 160)}`)
  }
  return out
}

/** Every case's result, and whether the whole run passed. */
export function summarise(results) {
  const failed = results.filter((r) => r.checks.some((c) => !c.ok))
  return { passed: results.length - failed.length, failed: failed.length, total: results.length, ok: failed.length === 0 }
}
