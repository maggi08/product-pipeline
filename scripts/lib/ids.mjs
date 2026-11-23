/**
 * Epic ids: the placement table of the contract, the scan of a line for ids and the decision states. Shared by the lint modes
 * (brief, jira, text, handoff) and handoff.mjs. Node 22, no dependencies.
 */
import { existsSync, readFileSync } from 'node:fs'
import { clean, col, emptyish, tables, visibleLines } from './markdown.mjs'

/** `{ F: [patterns], Q: [...], ... }` — files where each id may appear (defined in + may appear in); null when the table cannot be read. */
export const readIdRules = (contractPath) => {
  if (!existsSync(contractPath)) return null
  const lines = visibleLines(readFileSync(contractPath, 'utf8'))
  const table = tables(lines).find((t) => t.header.some((h) => /may appear in/.test(h)) && t.header.some((h) => /^id$/.test(h)))
  if (!table) return null
  const idCol = col(table.header, /^id$/)
  const defCol = col(table.header, /defined in/)
  const mayCol = col(table.header, /may appear in/)
  const rules = {}
  for (const row of table.rows) {
    const letter = clean(row.cells[idCol]).match(/^([A-Z])<n>$/)?.[1]
    if (!letter) continue
    const patterns = []
    for (const cellText of [row.cells[defCol], row.cells[mayCol]]) {
      // comma-separated entries; the first word of an entry is the path, and only a path (a dot or a trailing slash) counts
      for (const entry of (cellText ?? '').split(',')) {
        const word = clean(entry).split(/\s+/)[0] ?? ''
        if (!word || !(word.includes('.') || word.endsWith('/'))) continue
        patterns.push(word)
      }
    }
    rules[letter] = patterns
  }
  return Object.keys(rules).length >= 4 ? rules : null
}

/** The id rules of the contract, or exit 2: a lint that cannot read the table must not pass everything. */
export const idRulesOrExit = (contractPath) => {
  const rules = readIdRules(contractPath)
  if (!rules) {
    console.error(`product-lint: cannot read the id table ("May appear in" column) from ${contractPath}`)
    process.exit(2)
  }
  return rules
}

/** The distinct epic ids (`D14`, `T1`) on a line whose letter is in `letters`, in order of appearance. */
export const epicIdsIn = (line, letters) => {
  const set = new Set(letters)
  return [...new Set([...line.matchAll(/\b([A-Z])(\d+)\b/g)].filter((m) => set.has(m[1])).map((m) => m[0]))]
}

/** A quarter ("Q1 2027") is a date, not a data request. */
export const QUARTER = /\bQ[1-4]\s+(19|20)\d\d\b/g
/** A path into the epic's own files: a ticket reader does not have the product repo. Two forms: a path inside the epic (not after a `/`, so not part of a URL) and a path through `epics/<slug>/` written from anywhere. */
export const EPIC_FILE = /(?<![\w/.-])(?:(?:data|research|checks|messages|adopted|handoff)\/[\w./-]+|(?:BRIEF|FACTS|STATUS|INTAKE|JIRA|PROJECT)\.md\b)/g
export const EPICS_PATH = /(?:^|[\s(`"'])((?:[\w.-]+\/)*epics\/[\w-]+\/[^\s)`"']+)/g
/** An enum-like token (`LEGACY_COMBINED_SLOT`): a code name a ticket reader does not know. */
export const ENUM_LIKE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g

/** The ticket-text line without quarters (dates); a path into the epic is a finding of its own, so only quarters are dates. */
export const forTicketIds = (line) => line.replace(QUARTER, '')

/** The ids the contract bans in ticket texts: the contract's table plus the problem ids (`P<n>`) its sentence adds. */
export const bannedLetters = (contractPath) => [...Object.keys(idRulesOrExit(contractPath)), 'P']

/**
 * The ticket-text rules for one line, the one copy for the lint (jira, text, handoff) and the handoff script:
 * `[{ rule, match, message }]` for epic ids, section references, the word "brief", paths into the epic and, with `enums`, enum-like tokens.
 * `exempt` may hold 'brief' and 'path' (the From line names the product repo and the epic folder).
 */
export const textRuleHits = (raw, banned, { exempt = [], enums = false } = {}) => {
  const line = forTicketIds(raw)
  const hits = []
  for (const id of epicIdsIn(line, banned)) {
    hits.push({ rule: 'ticket-epic-id', match: id, message: `${id} is an epic id: a ticket reader does not have the epic. Write the decision out as "question: recommendation → who decides", or name the ticket by its summary or key` })
  }
  for (const m of line.matchAll(/§\s*\d+/g)) hits.push({ rule: 'ticket-section-ref', match: m[0], message: `"${m[0]}" is a section reference into the brief: say what the section says` })
  if (!exempt.includes('brief') && /\bbrief\b/i.test(line)) hits.push({ rule: 'ticket-brief-ref', match: 'brief', message: 'the word "brief" refers to a document the ticket reader does not have: write what it says (or rephrase if the word is used in its ordinary sense)' })
  if (!exempt.includes('path')) {
    for (const m of [...line.matchAll(EPIC_FILE)].map((x) => x[0]).concat([...line.matchAll(EPICS_PATH)].map((x) => x[1]))) {
      hits.push({ rule: 'ticket-epic-file', match: m, message: `"${m}" is a file of the product repo: a ticket reader does not have it. Put what it says into the ticket` })
    }
  }
  if (enums) for (const m of line.matchAll(ENUM_LIKE)) hits.push({ rule: 'ticket-enum-token', match: m[0], message: `"${m[0]}" is a code name (an enum value): a ticket reader does not know it, write what it means` })
  return hits
}

/**
 * The one set of decision states (the contract's table, the lint and the handoff): `open`, `pending data Q<n>`, `decided <YYYY-MM-DD> <who>`.
 * `parseState(cell)` is `{ kind: 'open' }`, `{ kind: 'pending', q }`, `{ kind: 'decided', date, who }`, or null for anything else (a `decided <date>` with no author included).
 */
export const parseState = (cell) => {
  const st = clean(cell)
  if (/^open$/i.test(st)) return { kind: 'open' }
  const pending = st.match(/^pending data (Q\d+)$/i)
  if (pending) return { kind: 'pending', q: pending[1] }
  const decided = st.match(/^decided (\d{4}-\d{2}-\d{2}) (.+)$/i)
  if (decided && !emptyish(decided[2])) return { kind: 'decided', date: decided[1], who: decided[2].trim() }
  return null
}
