/**
 * JIRA.md read once, for the lint and for the handoff: the key map, the ticket headings, and the link between them.
 * A ticket is tied to its key map row by the id comment on its heading (`<!-- T1.1 -->`) or, for a ticket created
 * before the plugin, by the Jira key at the start of the heading (`<KEY> · Sub-task — ...`); either way the row's Key must be the heading's key.
 * Node 22, no dependencies.
 */
import { bodyOf, clean, col, emptyish, headings, tables, visibleLines } from './markdown.mjs'

/** A key map row id: `E`, `T<n>`, `T<n>.<m>` (the source, the whole-value form, and the form that finds ids inside a cell). */
export const MAP_ID_SOURCE = 'E|T\\d+(?:\\.\\d+)?'
export const MAP_ID = new RegExp(`^(${MAP_ID_SOURCE})$`)
export const MAP_ID_IN = new RegExp(`\\b(${MAP_ID_SOURCE})\\b`, 'g')
/** The id comment on a ticket heading: `### Sub-task: [BE] summary <!-- T1.1 -->`. */
export const ID_COMMENT = new RegExp(`<!--\\s*(${MAP_ID_SOURCE})\\s*-->`)
/** The one source of a Jira key's form, as regex source: capital letters, a dash, digits. */
export const KEY = '[A-Z][A-Z0-9]+-\\d+'
/** The key at the start of a created ticket's heading: `<KEY> · Sub-task — ...`. */
export const KEY_PREFIX = new RegExp(`^(${KEY})\\s*[·•]\\s*`)
/** A Jira issue key, the whole value: the one form a key cell, a handoff argument and a path segment may have. */
export const KEY_FORM = new RegExp(`^${KEY}$`)
/** A Jira issue key at the start of a text (a handoff title). */
export const KEY_START = new RegExp(`^${KEY}\\b`)
/** A leading "(not created)" on a heading of a hand-made draft: not part of the ticket's summary. */
const NOT_CREATED = /^\(not created\)\s*/i
const TAG = /\[(BE|FE|Design)(?:\s+([^\]]*))?\]/i

export const squash = (v) => clean(v).replace(/\s+/g, ' ')
const cellId = (cell) => clean(cell).replace(/\*/g, '')

/** What a heading is: `<key> · <Type> — <summary>`, `<Type>: <summary>`, `<Type> [tag] <summary>`, `[tag] <summary>`; the tag may stand anywhere in it. */
export const parseHeading = (text) => {
  const key = text.match(KEY_PREFIX)?.[1] ?? null
  const rest = key ? text.replace(KEY_PREFIX, '') : text
  const tm = rest.match(/^(epic|story|task|sub-?task)\b/i)
  const type = tm ? tm[1].toLowerCase().replace('-', '') : null
  const after = tm ? rest.slice(tm[0].length) : rest
  const sep = tm ? after.match(/^\s*[:—–-]\s*/) : null
  const summary = (tm ? after.slice(sep ? sep[0].length : 0) : after).trim()
  const tag = rest.match(TAG)
  const isEpic = type === 'epic' || (!type && !tag && /\bepic\b/i.test(rest))
  const isSub = !isEpic && type !== 'story' && (type === 'subtask' || Boolean(tag))
  const isTicket = isEpic || isSub || Boolean(key) || (type !== null && Boolean(sep))
  return { key, type, summary, tag: tag?.[1].toUpperCase() ?? null, app: tag ? clean(tag[2] ?? '') : '', isEpic, isSub, isTicket }
}

/**
 * `{ raw, lines, heads, map, rows, bad, rowById, rowByKey, exempt, tickets }`.
 * map: the table with a Key column (not the first) whose first cells are mostly ids, or null; `bad` are its rows whose first cell is no id (not in `rows`).
 * tickets: every ticket heading below the title (a heading with an id comment is a ticket), with `id` (comment), `key` (heading prefix),
 * `row` (its map row or null), `keyed` (already created), `from`/`to` (body line bounds).
 */
export const readJira = (text) => {
  const raw = text.split('\n')
  const lines = visibleLines(text)
  const heads = headings(lines)
  const map =
    tables(lines).find((t) => col(t.header, /^key$/) > 0 && t.rows.length > 0 && t.rows.filter((r) => MAP_ID.test(cellId(r.cells[0]))).length * 2 > t.rows.length) ?? null
  const rows = []
  const bad = []
  const exempt = new Set()
  if (map) {
    for (let l = map.headerLine; l <= map.headerLine + 1 + map.rows.length; l++) exempt.add(l)
    const [keyCol, sumCol] = [col(map.header, /^key$/), col(map.header, /^summary/)]
    for (const r of map.rows) {
      const id = cellId(r.cells[0])
      if (!MAP_ID.test(id)) bad.push({ line: r.line, cell: id })
      else rows.push({ line: r.line, id, key: clean(r.cells[keyCol]), summary: sumCol < 0 ? '' : squash(r.cells[sumCol]) })
    }
  }
  const rowById = new Map(rows.map((r) => [r.id, r]))
  const rowByKey = new Map(rows.filter((r) => !emptyish(r.key)).map((r) => [r.key, r]))
  // a ticket runs to the next heading of the same or a higher level, or to the next ticket heading; the level-1 heading is the document's title
  const tickets = heads
    .filter((h) => h.level > 1)
    .map((h) => {
      const p = parseHeading(h.text.replace(NOT_CREATED, ''))
      return { h, ...p, id: raw[h.index].match(ID_COMMENT)?.[1] ?? null, isTicket: p.isTicket || ID_COMMENT.test(raw[h.index]) }
    })
    .filter((t) => t.isTicket)
  for (const t of tickets) {
    t.from = t.h.index + 1
    t.to = Math.min(bodyOf(heads, t.h, lines.length).to, tickets.find((n) => n.h.index > t.h.index)?.h.index ?? lines.length)
    t.row = (t.id ? rowById.get(t.id) : t.key ? rowByKey.get(t.key) : null) ?? null
    t.keyed = Boolean(t.key) || Boolean(t.row && !emptyish(t.row.key))
  }
  return { raw, lines, heads, map, rows, bad, rowById, rowByKey, exempt, tickets }
}

/** A ticket by its Jira key: key → map row → the heading with that row's id comment, or with that key at its start and no id comment. `{ row, ticket }`, each null when missing. */
export const findTicket = (jira, key) => {
  const row = jira.rowByKey.get(key) ?? null
  const ticket = row ? (jira.tickets.find((t) => t.id === row.id || (!t.id && t.key === key)) ?? null) : null
  return { row, ticket }
}
