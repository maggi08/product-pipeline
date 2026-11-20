#!/usr/bin/env node
/**
 * Lint of an epic's files. Free, no model calls, no dependencies.
 *
 *   node product-lint.mjs <epic dir> [--mode brief|jira|text|handoff] [--file <draft>] [--template message|jira] [--allow brief] [--json]
 *
 * One output form, one line per finding: `file:line — rule — message` (file relative to the epic dir).
 * Exit 0 with no findings, 1 with any finding, 2 when the lint cannot run (usage, unreadable contract).
 *
 * Modes. Each mode is a function of the epic context that returns findings; `MODES` is the registry.
 *   brief    (this file) decisions, metrics, scope, fact and data-request references, id placement.
 *   jira     (this file) ticket texts in JIRA.md: no epic ids, apps named, criteria, the contract first, every ticket heading linked to its key-map row by an id comment,
 *            a key-map Key cell that is a Jira key and nothing else (`map-key-form`), one key per row (`map-key-duplicate`).
 *            The key map is the only place both worlds meet. Tickets that already have a Jira key skip the text rules (the drift check of /product-jira runs `--mode text` on their created text) but not the link rules: a heading is tied to its map row by an id comment or the key at its start.
 *   text     (this file) the ticket-text rules on any one file, `--file <draft>`: a stakeholder message or the stakeholder version of the brief before it is shown. `--template message` checks the draft
 *            against the placeholders of templates/message.md (default `jira`: those of JIRA.md, for the drift check of created tickets); `--allow brief` lets the word "brief" stand (the title of the brief's own stakeholder version).
 *   handoff  (this file) handoff files, `--file <path>` or every file of `<epic dir>/handoff/`: the version marker on line 1, the header fields and section names of templates/PRODUCT-HANDOFF.md,
 *            every H<n> criterion in WHEN … THEN …, decisions with a state, no epic ids outside the `From:` line, no placeholder of the template left.
 * A new mode adds one entry to MODES and reuses the helpers (`scripts/lib/markdown.mjs`, `idRules`, `finding`).
 *
 * Id placement is read from the contract at run time: the "May appear in" and "Defined in" columns of the table
 * "Epic ids" in references/product-repo.md. There is no second copy of that table in this file, so the two cannot
 * drift; if the table cannot be read the lint stops with exit 2 instead of passing everything.
 * Node 22, no dependencies.
 */
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bannedLetters, epicIdsIn, idRulesOrExit, parseState, QUARTER, textRuleHits } from './lib/ids.mjs'
import { KEY_FORM, KEY_START, readJira, squash } from './lib/jira.mjs'
import { appNames, bodyOf, clean, col, duplicateAppNames, emptyish, findApp, findApps, headings, isCriterion, labelOf, LIST_ITEM, section, tables, templateShape, visibleLines } from './lib/markdown.mjs'
import { appsOfEpic, CONTRACT_PATH, read, readIn } from './lib/project.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTRACT = CONTRACT_PATH

// arguments
const argv = process.argv.slice(2)
const json = argv.includes('--json')
let mode = 'brief'
let epicArg = null
let fileArg = null
let templateArg = 'jira'
let allowArg = []
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--json') continue
  if (a === '--mode') mode = argv[++i] ?? ''
  else if (a === '--file') fileArg = argv[++i] ?? ''
  else if (a === '--allow') allowArg = (argv[++i] ?? '').split(',')
  else if (a === '--template') templateArg = argv[++i] ?? ''
  else if (a.startsWith('--template=')) templateArg = a.slice(11)
  else if (a.startsWith('--mode=')) mode = a.slice(7)
  else if (a.startsWith('--allow=')) allowArg = a.slice(8).split(',')
  else if (a.startsWith('--file=')) fileArg = a.slice(7)
  else if (a.startsWith('--')) usage(`unknown option ${a}`)
  else if (epicArg === null) epicArg = a
  else usage(`unexpected argument ${a}`)
}
function usage(msg) {
  console.error(`product-lint: ${msg}\nusage: node product-lint.mjs <epic dir> [--mode brief|jira|text|handoff] [--file <draft>] [--template message|jira] [--allow brief] [--json]`)
  process.exit(2)
}

// helpers

/** A data request is named by its file (data/Q3-slug.md); the one pattern for that name. */
// a relative, absolute (`/…`) or home (`~/…`) path; the start is anchored (`(?<![\w./~-])`) so a long line of word characters is scanned once, not once per start position
const REQUEST_FILE = /(?<![\w./~-])(?:~?\/)?(?:[\w.-]+\/)*Q\d+-[\w-]+\.(?:md|sql|csv|out)\b/g
/** The brief's line without file names of data requests and without quarters: what is left is read for ids. */
const forIds = (line) => line.replace(REQUEST_FILE, '').replace(QUARTER, '')

const findings = []
const finding = (file, line, rule, message) => findings.push({ file, line, rule, message })

// id placement, from the contract (`scripts/lib/ids.mjs`)
const matchesPattern = (rel, pattern) => {
  if (pattern.endsWith('/')) return rel.startsWith(pattern)
  if (pattern.includes('<')) return new RegExp(`^${pattern.replace(/[.+*?^${}()|[\]\\]/g, '\\$&').replace(/<[^>]*>/g, '[^/]*')}$`).test(rel)
  return rel === pattern
}

/** Epic ids outside the files the contract allows. Files under adopted/ are kept as they were and are not read. */
const idRules = (epic, rules) => {
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      if (['.git', 'node_modules', 'adopted'].includes(name)) return []
      const abs = join(dir, name)
      // lstat: a symlink (a loop, a link out of the epic) is neither followed nor read
      const st = lstatSync(abs)
      return st.isDirectory() ? walk(abs) : st.isFile() && name.endsWith('.md') ? [abs] : []
    })
  for (const abs of walk(epic)) {
    const rel = relative(epic, abs).split('\\').join('/')
    const lines = visibleLines(read(abs, epic) ?? '')
    lines.forEach((raw, i) => {
      // a data request file name is a path, a quarter is a date: neither is a reference
      for (const id of epicIdsIn(forIds(raw), Object.keys(rules))) {
        const letter = id[0]
        if (rules[letter].some((p) => matchesPattern(rel, p))) continue
        finding(rel, i + 1, 'id-not-allowed', `${id} may not appear in ${rel}: the contract lets ${letter}<n> appear only in ${rules[letter].join(', ')}`)
      }
    })
  }
}

// brief mode
const lintBrief = (epic) => {
  const briefText = readIn(epic, 'BRIEF.md')
  if (briefText === null) {
    finding('BRIEF.md', 1, 'brief-missing', 'there is no BRIEF.md in the epic folder')
    return
  }
  const lines = visibleLines(briefText)

  // facts and data requests that exist
  const factsLines = visibleLines(readIn(epic, 'FACTS.md') ?? '')
  const factIds = new Set()
  for (const t of tables(factsLines)) for (const r of t.rows) if (/^F\d+$/.test(clean(r.cells[0]))) factIds.add(clean(r.cells[0]))
  const dataDir = join(epic, 'data')
  const requestIds = new Set(
    (existsSync(dataDir) && lstatSync(dataDir).isDirectory() ? readdirSync(dataDir) : []).map((f) => f.match(/^Q(\d+)-.+\.md$/)?.[1]).filter(Boolean).map((n) => `Q${n}`),
  )

  // required sections
  const need = (re, label) => {
    const s = section(lines, re)
    if (!s) finding('BRIEF.md', 1, 'section-missing', `no "${label}" section`)
    return s
  }
  // headings may carry a number ("8. Decisions needed"); the skeleton stays English whatever the prose language
  const decisions = need(/^(\d+\.\s*)?decisions\b/i, 'Decisions')
  const metrics = need(/^(\d+\.\s*)?goals and (success )?metrics\b/i, 'Goals and metrics')
  // scope: the template's `v1` subsection (| Item | Task |), or a Scope section whose table has a v1 column (the v1 / Later / Out matrix of a hand-made brief)
  const scope = section(lines, /^(\d+\.\s*)?(scope\s+)?v1\b/i)
  let matrixScope = []
  if (!scope) {
    const whole = section(lines, /^(\d+\.\s*)?scope\b/i)
    const matrix = whole ? tables(lines, whole.from, whole.to).some((t) => col(t.header, /^v1\b/) >= 0) : false
    if (!matrix) finding('BRIEF.md', whole?.line ?? 1, 'section-missing', 'no v1 column or v1 subsection under Scope')
    else matrixScope = tables(lines, whole.from, whole.to).filter((t) => col(t.header, /^v1\b/) >= 0)
  }
  const split = section(lines, /^(\d+\.\s*)?epic and tasks\b/i)

  // decisions: an owner, a state from the whitelist, no recommendation while the state is not open or decided
  if (decisions) {
    // a decisions table is one that has a D<n> row, so a table without Owner or State is a finding, not skipped
    const found = tables(lines, decisions.from, decisions.to).filter((t) => t.rows.some((r) => /^D\d+$/.test(clean(r.cells[0]).replace(/\*/g, ''))))
    if (!found.length) finding('BRIEF.md', decisions.line, 'decisions-table', 'the Decisions section has no table with D<n> rows')
    for (const table of found) {
      const [owner, recommendation, state] = [/^owner$/, /^recommendation$/, /^state$/].map((re) => col(table.header, re))
      for (const [idx, name] of [[owner, 'Owner'], [recommendation, 'Recommendation'], [state, 'State']]) {
        if (idx < 0) finding('BRIEF.md', table.headerLine, 'decisions-table', `the decisions table has no ${name} column`)
      }
      for (const row of table.rows) {
        const id = clean(row.cells[0]).replace(/\*/g, '')
        if (!/^D\d+$/.test(id)) continue
        if (owner >= 0 && emptyish(row.cells[owner])) finding('BRIEF.md', row.line, 'decision-no-owner', `${id} has no owner`)
        if (state < 0) continue
        const st = clean(row.cells[state])
        const parsed = parseState(st)
        const settled = parsed?.kind === 'open' || parsed?.kind === 'decided'
        if (!parsed) {
          finding('BRIEF.md', row.line, 'decision-state', `${id} has state "${st}": write open, pending data Q<n>, or decided <YYYY-MM-DD> <who>`)
        }
        if (!settled && recommendation >= 0 && !emptyish(row.cells[recommendation])) {
          finding('BRIEF.md', row.line, 'pending-data-recommendation', `${id} is not open or decided and has a recommendation: write — until the numbers arrive`)
        }
      }
    }
  }

  // metrics: a baseline that cites a fact, or exactly "no baseline — Q<n>"
  if (metrics) {
    const found = tables(lines, metrics.from, metrics.to).filter((t) => col(t.header, /baseline/) >= 0)
    if (!found.length) finding('BRIEF.md', metrics.line, 'metrics-table', 'the Goals and metrics section has no table with a Baseline column')
    for (const table of found) {
      const b = col(table.header, /baseline/)
      const m = Math.max(col(table.header, /^metric$/), 0)
      for (const row of table.rows) {
        const name = clean(row.cells[m])
        if (!name) continue
        const base = clean(row.cells[b])
        if (/^no baseline — Q\d+$/i.test(base) || /\bF\d+\b/.test(base)) continue
        const hint = 'give the number with its fact (F<n>), or exactly "no baseline — Q<n>"'
        finding('BRIEF.md', row.line, 'metric-no-baseline', emptyish(base) ? `metric "${name}" has no baseline: ${hint}` : `metric "${name}" has baseline "${base}": ${hint}`)
      }
    }
  }

  // scope v1: once the split section holds tasks, every v1 item names one that exists
  const taskIds = new Set()
  if (split) for (const t of tables(lines, split.from, split.to)) for (const r of t.rows) if (/^T\d+$/.test(clean(r.cells[0]))) taskIds.add(clean(r.cells[0]))
  if (scope) {
    const found = tables(lines, scope.from, scope.to)
    if (!found.length) finding('BRIEF.md', scope.line, 'scope-table', 'the v1 scope is not a table with Item and Task columns')
    else if (taskIds.size) {
      for (const table of found) {
        const t = col(table.header, /task/)
        if (t < 0) {
          finding('BRIEF.md', table.headerLine, 'scope-table', 'the v1 scope table has no Task column')
          continue
        }
        for (const row of table.rows) {
          if (emptyish(row.cells[0])) continue
          const named = [...clean(row.cells[t]).matchAll(/\bT\d+\b/g)].map((m) => m[0])
          if (!named.length) finding('BRIEF.md', row.line, 'scope-no-task', `v1 item "${clean(row.cells[0])}" has no task, and the split section is filled`)
          else for (const id of named) if (!taskIds.has(id)) finding('BRIEF.md', row.line, 'scope-no-task', `v1 item "${clean(row.cells[0])}" names ${id}, which is not in the Epic and tasks section`)
        }
      }
    }
  }

  // the v1 / Later / Out matrix has no Task column of its own: when it has one (the split adds it), every item in its v1 column names a task that exists
  if (taskIds.size) {
    for (const table of matrixScope) {
      const t = col(table.header, /task/)
      const v = col(table.header, /^v1\b/)
      if (t < 0) continue
      for (const row of table.rows) {
        if (emptyish(row.cells[v]) || /^(no|n)$/i.test(clean(row.cells[v])) || emptyish(row.cells[0])) continue
        const named = [...clean(row.cells[t]).matchAll(/\bT\d+\b/g)].map((m) => m[0])
        if (!named.length) finding('BRIEF.md', row.line, 'scope-no-task', `v1 item "${clean(row.cells[0])}" has no task, and the split section is filled`)
        else for (const id of named) if (!taskIds.has(id)) finding('BRIEF.md', row.line, 'scope-no-task', `v1 item "${clean(row.cells[0])}" names ${id}, which is not in the Epic and tasks section`)
      }
    }
  }

  // references: F<n> defined in FACTS.md; Q<n> has a request file
  lines.forEach((l, i) => {
    for (const id of new Set([...l.matchAll(/\bF\d+\b/g)].map((m) => m[0]))) {
      if (!factIds.has(id)) finding('BRIEF.md', i + 1, 'fact-undefined', `${id} is not defined in FACTS.md${existsSync(join(epic, 'FACTS.md')) ? '' : ' (there is no FACTS.md)'}`)
    }
  })
  for (const file of ['BRIEF.md', 'FACTS.md', 'STATUS.md']) {
    const text = file === 'BRIEF.md' ? lines : visibleLines(readIn(epic, file) ?? '')
    text.forEach((l, i) => {
      for (const id of new Set([...forIds(l).matchAll(/\bQ\d+\b/g)].map((m) => m[0]))) {
        if (!requestIds.has(id)) finding(file, i + 1, 'request-missing', `${id} has no file data/${id}-<slug>.md`)
      }
    })
  }

  // id placement, from the contract
  idRules(epic, idRulesOrExit(CONTRACT))
}

// jira mode
/** The template's own placeholders (`<summary>`, `<condition>`, ...), read from templates/<name>: a real `<PARTNER>`-like token in prose is not one of them. */
const placeholderCache = new Map()
const placeholders = (name) => {
  if (placeholderCache.has(name)) return placeholderCache.get(name)
  const text = read(join(PLUGIN_ROOT, 'templates', name))
  const found = new Set(visibleLines(text ?? '').flatMap((l) => l.match(/<[^<>\n]+>/g) ?? []))
  if (!found.size) {
    console.error(`product-lint: cannot read the template placeholders from ${join(PLUGIN_ROOT, 'templates', name)}`)
    process.exit(2)
  }
  placeholderCache.set(name, [...found])
  return placeholderCache.get(name)
}

/** The ticket-text rules for one line (the shared `textRuleHits`) plus the placeholders: a placeholder of the template left in, and in a handoff a literal `H<n>`. Used by `jira`, `text` and `handoff`. */
const lintTextLine = (file, no, raw, banned, withPlaceholders = true, template = 'JIRA.md', exempt = []) => {
  for (const h of textRuleHits(raw, banned, { exempt })) finding(file, no, h.rule, h.message)
  const left = withPlaceholders ? placeholders(template).find((p) => raw.includes(p)) : null
  if (left) finding(file, no, 'placeholder-left', `${left} is a placeholder of the template: write the text it stands for`)
  // the handoff script writes `blocks H<n>:` for the criteria a question blocks: the H number is the reader's to write
  else if (withPlaceholders && template === 'PRODUCT-HANDOFF.md' && /\bH<n>/.test(raw)) finding(file, no, 'placeholder-left', 'H<n> is a placeholder: write the H number of every criterion the question blocks')
}
const lintJira = (epic) => {
  const text = readIn(epic, 'JIRA.md')
  if (text === null) {
    finding('JIRA.md', 1, 'jira-missing', 'there is no JIRA.md in the epic folder')
    return
  }
  const banned = bannedLetters(CONTRACT)
  const { raw, lines, heads, map, rows, bad, rowById, rowByKey, exempt, tickets: all } = readJira(text)

  // a key map row whose first cell is no id is named, not dropped with the map
  for (const b of bad) finding('JIRA.md', b.line, 'map-bad-id', `"${b.cell}" is not a key map id: use E, T<n> or T<n>.<m>`)

  // the lines of tickets that already have a key are not read for text rules (the drift check of /product-jira covers their text); the link rules below read every ticket
  const skipped = new Set()
  for (const t of all) if (t.keyed) for (let l = t.h.index; l < t.to; l++) skipped.add(l)

  // ticket texts: every line outside the key map and outside created tickets; the header (above the first section) has no template placeholders to check
  const firstSection = heads.find((h) => h.level > 1)?.index ?? lines.length
  // the lines above the key map are the file's own header notes (they are not pasted into Jira): no text-line rule (ids, "brief", paths, placeholders) reads them; the first ticket ends them when the map comes later
  const notes = map ? Math.min(map.headerLine - 1, all.length ? all[0].h.index : lines.length) : 0
  lines.forEach((l, i) => {
    if (i >= notes && !exempt.has(i + 1) && !skipped.has(i)) lintTextLine('JIRA.md', i + 1, l, banned, i >= firstSection)
  })

  const open = all.filter((t) => !t.keyed)

  // the link between a map row and a ticket text: the id comment on the heading, or the Jira key at its start; the row's Key must be that key
  if (!map) finding('JIRA.md', 1, 'key-map-missing', 'there is no key map (a table with an Id column and a Key column): without it a ticket cannot be found by its key')
  else {
    const claimed = new Set()
    const summaries = new Map()
    const keyLines = new Map()
    for (const r of rows) {
      if (emptyish(r.key)) continue
      if (!KEY_FORM.test(r.key)) finding('JIRA.md', r.line, 'map-key-form', `"${r.key}" is not a Jira key (capital letters, a dash, digits): the key cell holds the key only, not a URL or a path`)
      if (keyLines.has(r.key)) finding('JIRA.md', r.line, 'map-key-duplicate', `the key ${r.key} is also on line ${keyLines.get(r.key)}: one key per ticket`)
      else keyLines.set(r.key, r.line)
    }
    for (const t of all) {
      const line = t.h.index + 1
      const row = t.row
      if (!t.id && !t.key) {
        const guess = rows.filter((r) => emptyish(r.key) && !claimed.has(r.id) && r.summary && squash(t.h.text).includes(r.summary))
        if (guess.length === 1) claimed.add(guess[0].id)
        finding('JIRA.md', line, 'ticket-no-id', `the heading has no id comment: add <!-- ${guess.length === 1 ? guess[0].id : '<Id of its key map row>'} --> at its end (the form of a ticket already created is its Jira key at the start: \`<KEY> · Sub-task — ...\`), so the ticket is found by its map row`)
      } else if (t.id && !rowById.has(t.id)) {
        finding('JIRA.md', line, 'ticket-not-in-map', `the heading's id ${t.id} has no row in the key map`)
      } else if (!row) {
        finding('JIRA.md', line, 'ticket-not-in-map', `the heading's key ${t.key} is on no row of the key map: add the row, or fix the key`)
      } else if (claimed.has(row.id)) {
        finding('JIRA.md', line, 'ticket-id-duplicate', `another heading already stands for ${row.id}: one ticket per key map row`)
      } else {
        claimed.add(row.id)
        if (t.key && row.key !== t.key) {
          finding('JIRA.md', line, 'ticket-key-mismatch', `the heading's key ${t.key} is not the Key of its map row ${row.id} (${emptyish(row.key) ? 'none yet' : row.key}): the key map and the heading name one ticket`)
        } else if (!t.keyed && row.summary && squash(t.summary) !== row.summary) {
          finding('JIRA.md', line, 'map-summary', `the heading's summary "${squash(t.summary)}" is not the key map's summary for ${row.id} "${row.summary}": the map's summary is what is pasted into Jira, write the same text in both`)
        }
      }
      const s = squash(t.summary)
      if (s && !t.keyed) {
        if (summaries.has(s)) finding('JIRA.md', line, 'summary-duplicate', `the summary "${s}" is already used at line ${summaries.get(s)}: two tickets with one summary cannot be told apart`)
        else summaries.set(s, line)
      }
    }
    for (const r of rows) {
      if (!claimed.has(r.id)) finding('JIRA.md', r.line, 'map-no-ticket', `${r.id} has no ticket heading with <!-- ${r.id} -->${emptyish(r.key) ? '' : ` or with ${r.key} at its start`}`)
    }
  }

  // the epic
  const apps = appsOfEpic(epic)
  // two App repos rows with one Label (or one repo name) cannot be told apart by a ticket's [FE <app>]
  for (const d of apps ? duplicateAppNames(apps) : []) finding('PROJECT.md', 1, 'app-name-duplicate', `PROJECT.md App repos: the ${d.kind} "${d.name}" is on more than one row (${d.repos.join(', ')}): give each app its own`)
  const epics = all.filter((t) => t.isEpic)
  if (!epics.length) finding('JIRA.md', 1, 'epic-missing', 'there is no epic section (a heading with the word "Epic")')
  for (const t of epics.filter((e) => !e.keyed)) {
    const body = lines.slice(t.from, t.to)
    const at = body.findIndex((l) => labelOf(l, 'open decisions?'))
    // the first thing under the label is the list
    const after = at < 0 ? -1 : body.findIndex((l, k) => k > at && l.trim() !== '')
    const ok = after >= 0 && LIST_ITEM.test(body[after])
    if (!ok) finding('JIRA.md', (at >= 0 ? t.from + at : t.h.index) + 1, 'epic-no-open-decisions', 'the epic has no "Open decisions" list right under its label: write each as "question: recommendation → who decides", or one item "None" when all are decided')
  }

  // subtasks
  for (const t of open.filter((x) => x.isSub)) {
    const body = lines.slice(t.from, t.to)
    if (t.tag === 'FE') {
      if (!t.app) finding('JIRA.md', t.h.index + 1, 'fe-no-app', '[FE] has no app name: write [FE <app>] with an app from PROJECT.md')
      else if (apps && findApps(apps, t.app).length > 1) {
        finding('JIRA.md', t.h.index + 1, 'fe-ambiguous-app', `[FE ${t.app}] names more than one row of PROJECT.md App repos (${findApps(apps, t.app).map((a) => a.repo).join(', ')}): give each app its own Label`)
      } else if (!apps || !findApp(apps, t.app)) {
        finding('JIRA.md', t.h.index + 1, 'fe-unknown-app', `[FE ${t.app}]: ${apps ? `PROJECT.md App repos has no Label or repo "${t.app}" (it has ${appNames(apps)}): add a Label cell for the app in PROJECT.md, write [FE <app>] with a Label or repo name, or name the repo with --repo when the handoff is made` : 'no PROJECT.md above the epic folder to read the app names from'}`)
      }
    }
    // a criterion is one line WHEN <condition> THEN <result>; a placeholder left in it is reported by the line rule
    const criteria = body.filter(isCriterion).length
    if (!criteria) finding('JIRA.md', t.h.index + 1, 'subtask-no-criteria', 'the subtask has no criterion in the form "WHEN <condition> THEN <observable result>" on one line')
    if (t.tag === 'BE') {
      // the first deliverable: inline after the label, or the first thing under it, must be a list item
      let first = null
      let firstAt = t.h.index
      const label = body.map((l) => labelOf(l, 'deliverables?')).findIndex(Boolean)
      if (label >= 0) {
        const inline = labelOf(body[label], 'deliverables?').rest
        if (inline) [first, firstAt] = [inline, t.from + label]
        else {
          const next = body.findIndex((l, k) => k > label && l.trim() !== '')
          if (next >= 0 && LIST_ITEM.test(body[next])) [first, firstAt] = [body[next].match(LIST_ITEM)[2], t.from + next]
        }
      }
      if (first === null) finding('JIRA.md', t.h.index + 1, 'be-no-contract', 'the [BE] subtask has no Deliverables list whose first item is the API contract')
      else if (!/\bcontracts?\b/i.test(first)) finding('JIRA.md', firstAt + 1, 'be-no-contract', 'the first deliverable of a [BE] subtask is the API contract, reviewed by the frontend before implementation')
    }
  }
}

// text mode
/** `--template`: whose placeholders a draft is checked against: a ticket text (JIRA.md) or a stakeholder message (message.md). */
const TEXT_TEMPLATES = { jira: 'JIRA.md', message: 'message.md' }
/** The ticket-text rules on one file (`--file`): a message draft is checked before it is shown. */
const lintTextFile = () => {
  if (!fileArg) usage('--mode text needs --file <draft>')
  const path = resolve(fileArg)
  const text = read(path)
  if (text === null) usage(`${path} is not a file`)
  if (!TEXT_TEMPLATES[templateArg]) usage(`unknown template "${templateArg}" (templates: ${Object.keys(TEXT_TEMPLATES).join(', ')})`)
  const banned = bannedLetters(CONTRACT)
  // the stakeholder version of the brief is a text for readers without the epic, so the word "brief" is allowed on every line of the draft (the title and the text) with `--allow brief`, nothing else is exempt
  const exempt = allowArg.includes('brief') ? ['brief'] : []
  visibleLines(text).forEach((l, i) => lintTextLine(fileArg, i + 1, l, banned, true, TEXT_TEMPLATES[templateArg], exempt))
}

// handoff mode
const HANDOFF_TEMPLATE = 'templates/PRODUCT-HANDOFF.md'
/** The shape of a handoff, read from the template (the one copy of the spec's names): the marker line, the header fields, the section headings. */
const handoffShape = () => {
  const shape = templateShape(read(join(PLUGIN_ROOT, HANDOFF_TEMPLATE)))
  if (!shape) {
    console.error(`product-lint: cannot read the marker, the header fields and the sections from ${join(PLUGIN_ROOT, HANDOFF_TEMPLATE)}`)
    process.exit(2)
  }
  return shape
}
const DECISION_STATE = /—\s*(open(\s*—\s*waits for data:\s*\S.*)?|decided \d{4}-\d{2}-\d{2})\s*$/

/** One handoff file: the marker, the title, the header fields, the sections, the criteria, the decisions, the ids and placeholders. */
const lintHandoffFile = (file, text, shape, banned) => {
  const raw = text.split('\n')
  const lines = visibleLines(text)
  if (raw[0].trim() !== shape.marker) {
    const v = raw[0].trim().match(/^<!--\s*product-handoff\s+(\S+?)\s*-->$/)?.[1]
    finding(file, 1, 'handoff-marker', v ? `unknown handoff version "${v}": line 1 must be ${shape.marker}` : `line 1 must be the version marker ${shape.marker}`)
  }
  const titleAt = lines.findIndex((l) => /^#\s/.test(l))
  if (titleAt < 0 || !KEY_START.test(lines[titleAt].replace(/^#\s+/, ''))) finding(file, titleAt + 1 || 1, 'handoff-title', 'the title is "# <KEY>: <summary>" with the Jira key first')
  // header fields: between the title and the first section
  const firstSection = lines.findIndex((l) => /^##\s/.test(l))
  const head = lines.slice(0, firstSection < 0 ? lines.length : firstSection)
  for (const f of shape.fields) {
    const at = head.findIndex((l) => l.startsWith(`${f}:`))
    if (at < 0) finding(file, 1, 'handoff-field', `the header has no "${f}:" line`)
    else if (!head[at].slice(f.length + 1).trim()) finding(file, at + 1, 'handoff-field', `"${f}:" is empty`)
    else if (f === 'Type' && !/\[(FE\s+[^\]<>]+|BE)\]/.test(head[at])) finding(file, at + 1, 'handoff-field', 'Type is [FE <app>], [BE] or both, with a real app name')
    else if (f === 'From' && !head[at].includes(' · ')) finding(file, at + 1, 'handoff-field', 'From is "<product repo> · <epic folder>"')
  }
  // sections
  const sec = {}
  for (const name of shape.sections) {
    // level 2, as plan-check reads it: a `### Criteria` is not the section
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
    const h = headings(lines).find((x) => x.level === 2 && re.test(x.text))
    sec[name] = h ? { line: h.index + 1, ...bodyOf(headings(lines), h, lines.length) } : null
    if (!sec[name]) finding(file, 1, 'handoff-section', `no "## ${name}" section (a level-2 heading)`)
  }
  // criteria: every list item is `H<n>` WHEN … THEN … (a cancelled one only needs its reason); H numbers are not reused
  const items = (s, re = LIST_ITEM) => (s ? lines.slice(s.from, s.to).flatMap((l, k) => (re.test(l) ? [{ line: s.from + k + 1, text: l.match(re)[2].trim() }] : [])) : [])
  if (sec.Criteria) {
    // plan-check reads H lines that start with `-` or `*` only: a numbered list would give it no criteria
    for (const it of items(sec.Criteria, /^\s*(\d+[.)])\s+(.*)$/)) finding(file, it.line, 'handoff-criterion', 'a criterion is a `-` or `*` bullet: stage-plan does not read a numbered list')
    // a line that starts with `H<n>` and has no bullet is read by plan-check as a criterion (it does not need the marker) but is checked by nothing else here
    for (const [k, l] of lines.slice(sec.Criteria.from, sec.Criteria.to).entries()) {
      if (/^\s*\**`?H\d+`?\**(?=[\s:.,—–|)-]|$)/.test(l) && !/^\s*[-*]\s/.test(l)) finding(file, sec.Criteria.from + k + 1, 'handoff-criterion', 'a criterion is a `-` or `*` bullet: a line that starts with its H id but has no bullet is read by stage-plan and checked by nothing')
    }
    const found = items(sec.Criteria, /^\s*([-*])\s+(.*)$/)
    if (!found.length) finding(file, sec.Criteria.line, 'handoff-criterion', 'the Criteria section has no criterion')
    const seen = new Map()
    for (const it of found) {
      const m = clean(it.text).match(/^H(\d+)\s+(.*)$/)
      if (!m) finding(file, it.line, 'handoff-criterion', 'a criterion starts with its own id: `H<n>` WHEN <condition> THEN <observable result>')
      else {
        if (seen.has(m[1])) finding(file, it.line, 'handoff-criterion', `H${m[1]} is also on line ${seen.get(m[1])}: an H number is never reused`)
        else seen.set(m[1], it.line)
        if (!/^\[cancelled:\s*\S.*\]/i.test(m[2]) && !isCriterion(m[2])) finding(file, it.line, 'handoff-criterion', `H${m[1]} is not in the form WHEN <condition> THEN <observable result>`)
      }
    }
  }
  // decisions: question — decision — who decides — open | open — waits for data: <what> | decided <date>
  for (const it of items(sec.Decisions)) {
    if (emptyish(it.text)) continue
    if (!DECISION_STATE.test(it.text)) finding(file, it.line, 'handoff-decision', 'a decision ends with its state: "<question> — <decision> — <who decides> — open | open — waits for data: <what> | decided <YYYY-MM-DD>"')
  }
  // ids and placeholders, on every visible line; on the From line of the header only the path and the word "brief" are let through (the product repo and the epic folder are named there); ids and section references are findings there too
  const fromAt = head.findIndex((l) => l.startsWith('From:'))
  lines.forEach((l, i) => lintTextLine(file, i + 1, l, banned, true, 'PRODUCT-HANDOFF.md', i === fromAt ? ['path', 'brief'] : []))
}

const lintHandoff = (epic) => {
  const shape = handoffShape()
  const banned = bannedLetters(CONTRACT)
  const targets = fileArg
    ? [resolve(fileArg)]
    : existsSync(join(epic, 'handoff')) ? readdirSync(join(epic, 'handoff')).filter((n) => n.endsWith('.md')).sort().map((n) => join(epic, 'handoff', n)) : []
  if (!fileArg && !targets.length) finding('handoff/', 1, 'handoff-missing', 'there is no handoff file in handoff/ (pass --file <path> to check one elsewhere)')
  for (const abs of targets) {
    const text = read(abs, fileArg ? undefined : epic)
    if (text === null) usage(`${abs} is not a file`)
    const rel = relative(epic, abs).split('\\').join('/')
    lintHandoffFile(rel.startsWith('..') ? fileArg : rel, text, shape, banned)
  }
}

/** mode name → function(epicDir). */
const MODES = { brief: lintBrief, jira: lintJira, text: lintTextFile, handoff: lintHandoff }

// run
if (!epicArg) usage('no epic dir')
if (!MODES[mode]) usage(`unknown mode "${mode}" (modes: ${Object.keys(MODES).join(', ')})`)
const epic = resolve(epicArg)
if (!existsSync(epic) || !statSync(epic).isDirectory()) usage(`${epic} is not a directory`)

MODES[mode](epic)

findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
if (json) console.log(JSON.stringify({ mode, epic, count: findings.length, findings }, null, 2))
else {
  for (const f of findings) console.log(`${f.file}:${f.line} — ${f.rule} — ${f.message}`)
  console.error(findings.length ? `product-lint (${mode}): ${findings.length} finding(s)` : `product-lint (${mode}): no findings`)
}
process.exit(findings.length ? 1 : 0)
