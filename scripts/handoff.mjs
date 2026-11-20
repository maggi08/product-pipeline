#!/usr/bin/env node
/**
 * The deterministic part of /product-handoff: one ticket of JIRA.md by its Jira key, assembled into the text of PRODUCT-HANDOFF.md.
 * Read-only: it writes no file. The skill shows the result, gets the user's yes, writes it and runs the lint.
 *
 *   node handoff.mjs <epic dir> <KEY> [--repo <app repo name>] [--json]
 *
 * Without --json: the handoff text on stdout, the warnings on stderr. With --json: `{ key, content, warnings, rewritten, carried, openDecisions,
 * appRepo, appPath, appExists, taskPath, taskPathSource, target, targetExists, copy, copyExists, next }`.
 * Exit 0 when the text is assembled, 1 when it cannot be (no such key, not a [FE <app>] / [BE] subtask, no app repo, a path that leaves its folder), 2 on usage or an unreadable template.
 * A ticket is read in every form `product-lint --mode jira` accepts (labels `**Criteria**`, `Acceptance criteria:`, `## Criteria`; a Decisions column of any name that has "decisions" in it).
 * A block runs to the next label the template knows (`Criteria`, `Out of scope`, …), a heading of its own (`**Notes**`, `## Notes`) or a `---` line: a sub-label inside the list (`Requests table:`, `Note:`) does not end it. A WHEN … THEN … line outside the Criteria block is a criterion too, with a warning.
 * What the ticket or the key map does not say is never written as "none": the line is a placeholder the lint rejects, and a warning says why. The design source of an [FE] ticket is a Figma link or a prototype path
 * in the ticket or in a [Design] subtask that blocks the ticket or shares its (non-epic) parent; none found: the placeholder and a warning (a [BE] ticket says "none").
 * A repeated handoff keeps the H numbers of the copy in the epic (`handoff/<KEY>.md`): a criterion that is gone becomes `[cancelled: ...]`, a new one gets the next number.
 * A rewritten criterion carries `<!-- src: <hash of the ticket line> -->` at the end of its H line (plan-check reads only the `H<n>` at the start), and a repeated handoff matches by it;
 * without a hash it is matched by position only when exactly one rewritten criterion and one ticket line are left. `carried` in --json lists each: `{ h, kept, ticket, by: 'hash' | 'position' }`.
 * The text is built on templates/PRODUCT-HANDOFF.md, so the template is the one copy of the spec's names.
 * A criterion that is not in the form WHEN <condition> THEN <result> comes out as a line with the template's placeholders and the mark
 * "rewritten from the ticket" (the skill rewrites it and shows the user); the lint then fails until it is.
 * Node 22, no dependencies.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bannedLetters, parseState, textRuleHits } from './lib/ids.mjs'
import { findTicket, KEY as KEY_SOURCE, KEY_FORM, MAP_ID, MAP_ID_IN, MAP_ID_SOURCE, readJira, squash } from './lib/jira.mjs'
import { appNames, bodyOf, clean, col, DIVIDER, EMPTY_ITEM, emptyish, FIELD_LINE, findApps, headings, isCriterion, labelOf, LIST_ITEM, SECTION_HEADING, section, tables, visibleLines } from './lib/markdown.mjs'
import { appPathOf, appsOfEpic, CONTRACT_PATH, findProject, read, readIn, taskDirOf } from './lib/project.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const usage = (msg) => {
  console.error(`handoff: ${msg}\nusage: node handoff.mjs <epic dir> <KEY> [--repo <app repo name>] [--json]`)
  process.exit(2)
}
const fail = (msg) => {
  console.error(`handoff: ${msg}`)
  process.exit(1)
}

const argv = process.argv.slice(2)
let json = false
let repoArg = null
const pos = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--json') json = true
  else if (argv[i] === '--repo') repoArg = argv[++i] ?? ''
  else if (argv[i].startsWith('--')) usage(`unknown option ${argv[i]}`)
  else pos.push(argv[i])
}
if (pos.length !== 2) usage('give the epic dir and the Jira key')
const [epicArg, KEY] = pos
if (!KEY_FORM.test(KEY)) usage(`"${KEY}" is not a Jira key (capital letters, a dash, digits)`)
const epic = resolve(epicArg)
if (!existsSync(epic)) usage(`${epic} is not a directory`)

const warnings = []
const warn = (m) => warnings.push(m)

// the ticket
const jiraText = readIn(epic, 'JIRA.md')
if (jiraText === null) fail(`there is no JIRA.md in ${epic}`)
const jira = readJira(jiraText)
const { row, ticket: t } = findTicket(jira, KEY)
if (!row) fail(`${KEY} is on no row of the key map in JIRA.md`)
if (!t) fail(`${KEY} is in the key map (${row.id}) but no ticket heading is tied to it`)
if (!t.isSub || !['FE', 'BE'].includes(t.tag)) fail(`${KEY} is not a [FE <app>] or [BE] subtask: a handoff is written for work that lands in a repo`)

// key map cells of a row: the Decisions column and the Blocked by column
const header = jira.map.header
const cellsOf = (r) => jira.map.rows.find((x) => x.line === r.line).cells
const decisionCol = col(header, /decisions/)
const blockedCol = col(header, /^blocked/)
const decisionIds = (r) => [...new Set([...clean(cellsOf(r)[decisionCol] ?? '').matchAll(/\bD\d+\b/g)].map((m) => m[0]))]
const rowOfRef = (ref) => (MAP_ID.test(ref) ? jira.rowById.get(ref) : jira.rowByKey.get(ref))
const blockedBy = (r) => [...clean(cellsOf(r)[blockedCol] ?? '').matchAll(MAP_ID_IN)].map((m) => jira.rowById.get(m[1])).filter(Boolean)
// the draft form has no Blocked by column: `Links ("blocks"): A→B, C→D and E` (keys or ids), the arrow reads "A blocks B"
const REF = `(?:${KEY_SOURCE}|${MAP_ID_SOURCE})`
const LINK = new RegExp(`(${REF})\\s*(?:→|->)\\s*(${REF}(?:\\s*(?:,|and|&)\\s*${REF})*)`, 'g')
const linkBlockers = (r) => {
  const out = []
  for (const l of jira.lines.filter((x) => /\bLinks\b.*\bblocks\b/i.test(x))) {
    for (const m of l.matchAll(LINK)) {
      const targets = [...m[2].matchAll(new RegExp(REF, 'g'))].map((x) => rowOfRef(x[0]))
      const from = rowOfRef(m[1])
      if (from && targets.includes(r) && !out.includes(from)) out.push(from)
    }
  }
  return out
}
const blockers = blockedCol >= 0 ? blockedBy(row) : linkBlockers(row)
const blockInfo = blockedCol >= 0 || blockers.length > 0
// a placeholder of the template, so the lint rejects the line until it is written: what the key map and the ticket do not say is never "none"
const DECISION_PLACEHOLDER = '- <question> — <decision or recommendation> — <who decides> — open'

// the ticket's labelled blocks, read with the lint's label reader: what, why, deliverables, criteria (also "Acceptance criteria"), depends on, out of scope, open decisions.
// A block runs to the next label the template knows or to a `---` line: a sub-label inside a list (`Requests table:`, `Note:`) is not the end of it.
const KNOWN = [['what', 'what'], ['why', 'why'], ['deliverables', 'deliverables?'], ['criteria', '(?:acceptance )?criteria'], ['depends on', 'depends on'], ['out of scope', 'out of scope'], ['open decisions', 'open decisions?'], ['decisions', 'decisions?'], ['contract', 'contract']]
// a line that is a heading of its own (`**Notes**`, `## Notes`) of a kind the template does not know ends the block too; `Note:` or `Requests table:` in a list does not
const HEADING_LABEL = /^\s*(?:#+\s+\S.*|(\*\*|__)[^*_:]{1,40}\1)\s*$/
const body = jira.lines.slice(t.from, t.to)
const blocks = {}
const inline = new Set()
const outside = []
let cur = null
for (const l of body) {
  if (DIVIDER.test(l)) {
    cur = null
    continue
  }
  const known = KNOWN.map(([name, word]) => [name, labelOf(l, word)]).find(([, m]) => m)
  if (known) {
    cur = known[0]
    blocks[cur] = known[1].rest ? [known[1].rest] : []
    if (known[1].rest) inline.add(cur)
  } else if (HEADING_LABEL.test(l)) cur = null
  else if (cur && l.trim()) blocks[cur].push(l)
  else if (!cur && l.trim()) outside.push(l)
}

// the app repo and its task folder
const root = findProject(epic)
const apps = appsOfEpic(epic) ?? []
const wanted = repoArg ?? (t.tag === 'FE' ? t.app : '')
if (!wanted) fail(`${KEY} is a [BE] subtask: name the repo it is done in with --repo <app repo name> (App repos of PROJECT.md: ${appNames(apps)})`)
// a ticket's [FE <app>] is a Label first, then a repo name; --repo is a repo name first, then a Label; one row must win its tier
const found = findApps(apps, wanted, { repoFirst: repoArg !== null })
if (!found.length) fail(`PROJECT.md App repos has no Label or repo "${wanted}" (it has ${appNames(apps)}): add a Label column cell for the app, or pass --repo <repo name>`)
if (found.length > 1) fail(`"${wanted}" names more than one row of PROJECT.md App repos (${found.map((a) => a.repo).join(' and ')}): give each app its own Label, or pass --repo <repo name>`)
const app = found[0]
if (emptyish(app.path)) fail(`PROJECT.md App repos has no Path for ${app.repo}: write its local path, the handoff would land in the product repo`)
const appPath = appPathOf(root, app.path)
const { taskPath, taskDir, source: taskPathSource } = taskDirOf(appPath, app.taskPath)
const target = join(taskDir, KEY, 'PRODUCT-HANDOFF.md')
const copy = join(epic, 'handoff', `${KEY}.md`)
// the two paths come from a key that has the Jira form and from configs: neither may leave its folder
const inside = (base, p) => {
  const r = relative(base, p)
  return r !== '' && !r.startsWith('..') && !isAbsolute(r)
}
if (!inside(taskDir, target)) fail(`the handoff path ${target} is not inside the task folder ${taskDir}`)
if (!inside(join(epic, 'handoff'), copy)) fail(`the copy path ${copy} is not inside ${join(epic, 'handoff')}`)
if (!existsSync(appPath)) warn(`the app repo path ${appPath} does not exist on this machine`)

// decisions: STATUS.md "Open decisions" first, the BRIEF.md decisions table as a fallback
const decisionRows = new Map()
const collect = (file, from) => {
  const text = readIn(epic, file)
  if (text === null) return
  const lines = visibleLines(text)
  const s = from ? section(lines, from) : null
  for (const tb of tables(lines, s?.from ?? 0, s?.to ?? lines.length)) {
    const [q, r, o, st] = [/^question/, /^recommendation/, /^owner/, /^state/].map((re) => col(tb.header, re))
    if (q < 0 || st < 0) continue
    for (const rw of tb.rows) {
      const id = clean(rw.cells[0]).replace(/\*/g, '')
      if (/^D\d+$/.test(id) && !decisionRows.has(id)) decisionRows.set(id, { question: squash(rw.cells[q]), recommendation: r < 0 ? '' : squash(rw.cells[r]), owner: o < 0 ? '' : squash(rw.cells[o]), state: squash(rw.cells[st]) })
    }
  }
}
collect('STATUS.md', /^open decisions$/i)
collect('BRIEF.md', /decisions/i)

const requestTitle = (q) => {
  const dir = join(epic, 'data')
  const f = existsSync(dir) ? readdirSync(dir).find((n) => new RegExp(`^${q}-.+\\.md$`).test(n)) : null
  const title = f ? readIn(epic, join('data', f))?.match(/^#\s+(.*)$/m)?.[1] : null
  return (title ? title.replace(/\bQ\d+\b\s*[—:–-]*\s*/g, '').trim() : '') || 'the answer to a data request'
}

if (decisionCol < 0) warn('the key map has no Decisions column: the decisions this task depends on are not known, the Decisions line is a placeholder to fill')
if (!blockInfo && t.tag === 'FE') warn('the key map has no Blocked by column and no Links ("blocks") line that names this ticket: the backend ticket it follows is not known, so the Contract line is a placeholder to fill and the open decisions of that ticket are not carried: ask which ticket blocks this one')
/** A summary without its leading [tag]. */
const noTag = (v) => squash(v).replace(/^\[[^\]]*\]\s*/, '')
const summary = noTag(t.summary)
const decisions = []
const openQuestions = []
const openDecisions = []
for (const rowOfDeps of [row, ...blockers]) {
  for (const id of decisionIds(rowOfDeps)) {
    if (decisions.some((d) => d.id === id)) continue
    const d = decisionRows.get(id)
    if (!d) {
      warn(`${id} is in the key map but in neither STATUS.md nor BRIEF.md: its line is left as a placeholder`)
      decisions.push({ id, line: DECISION_PLACEHOLDER })
      continue
    }
    const recommendation = emptyish(d.recommendation) ? 'no recommendation yet' : d.recommendation
    const owner = emptyish(d.owner) ? 'not named' : d.owner
    const parsed = parseState(d.state)
    const [pending, decided] = [parsed?.kind === 'pending' ? parsed : null, parsed?.kind === 'decided' ? parsed : null]
    let state = 'open'
    if (pending) state = `open — waits for data: ${requestTitle(pending.q)}`
    else if (decided) state = `decided ${decided.date}`
    else if (parsed?.kind !== 'open') warn(`${id} has the state "${d.state}", which is not open, pending data or decided: written as open`)
    decisions.push({ id, line: `- ${d.question} — ${recommendation} — ${owner} — ${state}` })
    if (!decided) {
      openDecisions.push({ id, question: d.question, state })
      openQuestions.push(`- ${d.question} — ${owner} — blocks H<n>: the criteria of "${summary}" that depend on it`)
      warn(`open decision the task depends on (${id}${rowOfDeps === row ? '' : `, from ${rowOfDeps.id}`}): ${d.question} — ${state}`)
    }
  }
}
if (decisionCol < 0) decisions.push({ id: null, line: DECISION_PLACEHOLDER })
// the ticket-text rules (the lint's own, `lib/ids.mjs`) over the lines this script assembles from the brief and STATUS.md: the script does not rewrite what they find, the skill does; enum-like tokens are a warning here only
const banned = bannedLetters(CONTRACT_PATH)
for (const [name, items] of [['Decisions', decisions.map((d) => d.line)], ['Open questions', openQuestions]]) {
  for (const l of items) {
    for (const h of textRuleHits(l, banned, { enums: true })) warn(`${name}: "${l.replace(/^-\s*/, '').slice(0, 70)}" — ${h.rule}: ${h.message} (the script leaves the text as it is)`)
  }
}
if (openQuestions.length) warn('Open questions: each line ends with "blocks H<n>: ..." — write the H number of every criterion the question blocks in place of H<n>, then show the user')
const dependsText = (blocks['depends on'] ?? []).join(' ').trim()
if (!decisions.length && dependsText && !/^none\b/i.test(clean(dependsText).replace(/^[“"']/, ''))) {
  warn(`the ticket says it depends on something that is not a decision of the key map ("${dependsText}"): add it to Decisions or Open questions if it is one`)
}

// criteria: H numbers are never reused, so a repeated handoff starts from the numbers of the existing copy
// a criterion is a list item of the Criteria block, or any line with WHEN … THEN … (the jira lint's own check): in the block without a bullet, after an inline label, or outside the block under another label
const fromTicket = []
const asCriterion = (text, why) => {
  const t2 = text.trim().replace(/^[-*]\s*/, '')
  fromTicket.push({ text: t2, ok: isCriterion(t2) })
  if (why) warn(`${why}: "${t2}" is taken as a criterion`)
}
blocks.criteria?.forEach((l, i) => {
  const m = l.match(LIST_ITEM)
  if (m) asCriterion(m[2])
  else if (isCriterion(l)) asCriterion(l, i === 0 && inline.has('criteria') ? 'a criterion stands on the label line, not in the list' : 'a criterion has no list bullet')
})
for (const l of outside.concat(Object.entries(blocks).filter(([k]) => k !== 'criteria').flatMap(([, v]) => v))) {
  const text = l.match(LIST_ITEM)?.[2] ?? l
  if (isCriterion(text)) asCriterion(text, 'a WHEN … THEN … line outside the Criteria list')
}
const MARK = /\s*\(rewritten from the ticket\)\s*$/i
const norm = (a) => squash(a).replace(MARK, '').toLowerCase()
const same = (a, b) => norm(a) === norm(b)
const srcHash = (text) => createHash('sha1').update(squash(text).toLowerCase()).digest('hex').slice(0, 8)
const SRC = /<!--\s*src:\s*([0-9a-f]+)\s*-->/
const existingText = read(copy, join(epic, 'handoff')) ?? read(target)
const prior = []
if (existingText !== null) {
  const raw = existingText.split('\n')
  const lines = visibleLines(existingText)
  const heads = headings(lines)
  const h = heads.find((x) => x.level === 2 && /^criteria$/i.test(x.text))
  if (h) {
    const { from, to } = bodyOf(heads, h, lines.length)
    for (let i = from; i < to; i++) {
      const m = lines[i].match(/^\s*[-*]\s+`?H(\d+)`?\s+(.*)$/)
      if (m) prior.push({ n: Number(m[1]), text: m[2].trim(), hash: raw[i].match(SRC)?.[1] ?? null, cancelled: /^\[cancelled:/i.test(m[2].trim()) })
    }
  }
}
const number = new Array(fromTicket.length).fill(null)
const carried = []
const taken = new Set()
const take = (i, p) => {
  number[i] = p.n
  p.keep = p.text
  taken.add(p.n)
}
fromTicket.forEach((c, i) => {
  const p = c.ok ? prior.find((x) => !x.cancelled && !taken.has(x.n) && same(x.text, c.text)) : null
  if (p) take(i, p)
})
// a criterion that had to be rewritten: the user's text stays with its number when the hash of the ticket line is the same
fromTicket.forEach((c, i) => {
  if (c.ok || number[i] !== null) return
  const p = prior.find((x) => !x.cancelled && !taken.has(x.n) && x.hash === srcHash(c.text))
  if (!p) return
  take(i, p)
  carried.push({ h: `H${p.n}`, kept: p.text.replace(MARK, ''), ticket: c.text, by: 'hash' })
})
// without a hash a rewritten criterion has no text to match by: exactly one left on each side is paired, otherwise each gets its own number
const unmatched = fromTicket.map((c, i) => i).filter((i) => !fromTicket[i].ok && number[i] === null)
const marked = prior.filter((x) => !x.cancelled && !taken.has(x.n) && (MARK.test(x.text) || x.hash))
if (unmatched.length === 1 && marked.length === 1) {
  const [i] = unmatched
  const p = marked[0]
  take(i, p)
  carried.push({ h: `H${p.n}`, kept: p.text.replace(MARK, ''), ticket: fromTicket[i].text, by: 'position' })
  warn(`criterion H${p.n} keeps its number and its text from the handoff already written: check that "${p.text.replace(MARK, '')}" still says what the ticket's "${fromTicket[i].text}" says`)
} else if (unmatched.length && marked.length) {
  warn(`${unmatched.length} criterion line(s) of the ticket not in the form WHEN … THEN … could not be matched to ${marked.map((p) => `H${p.n}`).join(', ')} of the handoff already written (the ticket changed): they get new numbers, the old ones are cancelled`)
}
let top = prior.reduce((m, x) => Math.max(m, x.n), 0)
const criteria = new Map()
const rewritten = []
prior.forEach((p) => {
  if (taken.has(p.n)) criteria.set(p.n, `- \`H${p.n}\` ${p.keep}${p.hash ? ` <!-- src: ${p.hash} -->` : ''}`)
  else if (p.cancelled) criteria.set(p.n, `- \`H${p.n}\` ${p.text}`)
  else {
    criteria.set(p.n, `- \`H${p.n}\` [cancelled: removed from the ticket]`)
    warn(`criterion H${p.n} is no longer in the ticket: it stays in the file as cancelled, its number is not reused`)
  }
})
fromTicket.forEach((c, i) => {
  if (number[i] !== null) return
  const n = ++top
  if (c.ok) criteria.set(n, `- \`H${n}\` ${c.text}`)
  else {
    criteria.set(n, `- \`H${n}\` WHEN <condition> THEN <observable result> (rewritten from the ticket) <!-- src: ${srcHash(c.text)} -->`)
    rewritten.push({ h: `H${n}`, original: c.text })
    warn(`criterion H${n} is not in the form WHEN … THEN …: rewrite it from "${c.text}" and show it to the user`)
  }
})
if (!fromTicket.length) {
  const n = ++top
  criteria.set(n, `- \`H${n}\` WHEN <condition> THEN <observable result> (rewritten from the ticket)`)
  warn('the ticket has no criterion lines: write them from its text and show them to the user')
}
const criteriaLines = [...criteria.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line)

// out of scope: the list items of the block, and every other non-empty line of it (prose under the label is an item too); the warning is only for a ticket with no such block
const outBlock = blocks['out of scope'] ?? []
const outLines = outBlock.flatMap((l) => [(l.match(LIST_ITEM)?.[2] ?? l).trim()]).filter((l) => l && !/^none\.?$/i.test(l))
if (!outBlock.some((l) => l.trim())) warn('the ticket names nothing out of scope (it has no Out of scope block): the section says so, ask the user whether something is excluded')

// design source: a Figma link or a prototype path in the ticket's own text; an [FE] ticket without one looks in the [Design] subtask that blocks it, else one under the same parent that is not the epic (a Figma file lives in the design subtask, not in the FE one).
// Nothing found: for [FE] the template's placeholder (the lint rejects it) and a warning, never "none"; a [BE] ticket has no screen and says "none". PROJECT.md has no design field and a link in it is not tied to this app.
const FIGMA = /https?:\/\/[^\s)>\]"'`]*figma\.com[^\s)>\]"'`]*/i
const PROTOTYPE = /\b(?:prototype(?:\s+path)?|design\s+source)\s*:\s*`?([^\s`<>]+)`?/i
const designIn = (lines) => {
  const text = lines.join('\n')
  const link = text.match(FIGMA)?.[0].replace(/[.,;:!?]+$/, '')
  if (link) return link
  const proto = text.match(PROTOTYPE)?.[1].replace(/[.,;:!?]+$/, '')
  return proto && !/^(none|n\/a|tbd|todo|—|-)$/i.test(proto) ? proto : null
}
const parentCol = col(header, /^parent/)
const parentOf = (r) => (parentCol < 0 ? '' : clean(cellsOf(r)[parentCol] ?? ''))
// the [Design] tickets to look in: first one that blocks this ticket (Blocked by or Links), else one under the same parent, but only a real parent: an empty cell or the epic row is shared by every task of a per-team project and says nothing about this screen
const isDesign = (d) => d.isSub && d.tag === 'DESIGN' && d.row && d.row !== row
const parentCell = parentOf(row)
const parentRow = emptyish(parentCell) ? null : rowOfRef(parentCell)
const parentIsEpic = Boolean(parentRow) && jira.tickets.some((d) => d.isEpic && d.row === parentRow)
const blockingDesign = jira.tickets.filter((d) => isDesign(d) && blockers.includes(d.row))
const siblingDesign = emptyish(parentCell) || parentIsEpic ? [] : jira.tickets.filter((d) => isDesign(d) && parentOf(d.row) === parentCell)
const designTickets = blockingDesign.length ? blockingDesign : siblingDesign
let designSource = designIn(body)
if (!designSource && t.tag === 'FE') designSource = designTickets.map((d) => designIn(jira.lines.slice(d.from, d.to))).find(Boolean) ?? null
const designFromParent = designSource !== null && !designIn(body)

// contract
const be = blockers.find((b) => /\[BE\]/.test(b.summary))
const templateText = read(join(PLUGIN_ROOT, 'templates/PRODUCT-HANDOFF.md'))
if (templateText === null) usage('templates/PRODUCT-HANDOFF.md is missing')
if (!designSource && t.tag === 'FE') {
  designSource = templateText.match(/^Design source:\s*(<.*>)\s*$/m)?.[1] ?? '<design source>'
  warn(`no Figma link or prototype path in the ticket${designTickets.length ? ' or in the [Design] subtask that blocks it or shares its parent' : ' (and no [Design] subtask blocks it or shares its parent)'}: the Design source line is a placeholder to fill: ask for the source of the design, or confirm "none" for a screen with no design`)
}
if (!designSource) designSource = 'none'
if (designFromParent) warn(`the design source comes from the [Design] subtask (${designSource}): check it is the design of this screen`)
const blockerContract = be ? `the contract of "${noTag(be.summary)}"${emptyish(be.key) ? '' : ` (${be.key})`}` : 'none'
const contract = t.tag === 'BE' ? 'stage 1 is the contract' : !blockInfo ? (templateText.match(/^Contract:\s*(<.*>)\s*$/m)?.[1] ?? '<contract>') : blockerContract

// assemble on the template
const sectionBody = {
  Criteria: criteriaLines,
  Decisions: decisions.length ? decisions.map((d) => d.line) : [EMPTY_ITEM],
  'Out of scope': outLines.length ? outLines.map((l) => `- ${l}`) : [EMPTY_ITEM],
  'Open questions': openQuestions.length ? openQuestions : [EMPTY_ITEM],
}
const fieldValue = {
  Type: `[${t.tag}${t.tag === 'FE' ? ` ${t.app}` : ''}]`,
  'App/Repo': app.repo,
  From: `${basename(root ?? epic)} · epics/${basename(epic)}`,
  'Design source': designSource,
  Contract: contract,
}
const out = []
let skipping = false
templateText.split('\n').forEach((l, i) => {
  if (i > 0 && /^<!--.*-->$/.test(l.trim())) return
  const h = l.match(SECTION_HEADING)
  if (h) {
    if (!(h[1] in sectionBody)) usage(`templates/PRODUCT-HANDOFF.md has a section "${h[1]}" this script does not fill`)
    out.push(l, ...sectionBody[h[1]])
    skipping = true
    return
  }
  if (skipping) {
    if (l.trim() === '') out.push('')
    return
  }
  const f = l.match(FIELD_LINE)?.[1]
  if (f && f in fieldValue) out.push(`${f}: ${fieldValue[f]}`)
  else if (/^#\s<KEY>/.test(l)) out.push(`# ${KEY}: ${summary}`)
  else out.push(l)
})
const content = `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`

const result = {
  key: KEY,
  content,
  warnings,
  rewritten,
  carried,
  openDecisions,
  appRepo: app.repo,
  appPath,
  appExists: existsSync(appPath),
  taskPath,
  taskPathSource,
  target,
  targetExists: existsSync(target),
  copy,
  copyExists: existsSync(copy),
  next: [`cd '${appPath.replace(/'/g, "'\\''")}'`, `/stage-pipeline:feature-checker ${KEY}`, `/stage-pipeline:stage-plan ${KEY}`],
}
if (json) console.log(JSON.stringify(result, null, 2))
else {
  process.stdout.write(content)
  for (const w of warnings) console.error(`warning: ${w}`)
}
