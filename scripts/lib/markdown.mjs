/**
 * Markdown helpers shared by the plugin's scripts (doctor, product-lint, handoff): rows, tables, sections,
 * cell cleanup and one vocabulary for "no value was given". Node 22, no dependencies.
 */

/** Lines with fenced code and HTML comments blanked out; line numbers stay. */
export const visibleLines = (text) => {
  let fence = false
  let comment = false
  return text.split('\n').map((line) => {
    if (/^\s*```/.test(line)) {
      fence = !fence
      return ''
    }
    if (fence) return ''
    let out = ''
    let rest = line
    while (rest.length) {
      if (comment) {
        const end = rest.indexOf('-->')
        if (end < 0) break
        rest = rest.slice(end + 3)
        comment = false
      } else {
        const start = rest.indexOf('<!--')
        if (start < 0) {
          out += rest
          break
        }
        out += rest.slice(0, start)
        rest = rest.slice(start + 4)
        comment = true
      }
    }
    return out
  })
}

/** A table row split on unescaped pipes (`\|` stays inside its cell). */
export const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim())
export const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
/** One table cell or bullet value: backticks stripped, `\|` unescaped, trimmed. */
export const clean = (v) => (v ?? '').replace(/\\\|/g, '|').replace(/`/g, '').trim()
/** An empty value, a `<placeholder>`, a dash, `tbd`: no value was given. */
export const emptyish = (v) => /^(|<.*>|—|–|-|\?|tbd|todo|none|n\/a)$/i.test(clean(v))

/** Tables inside lines[from, to): `{ header: [lowercase cells], headerLine, rows: [{ line, cells }] }`, lines are 1-based. */
export const tables = (lines, from = 0, to = lines.length) => {
  const out = []
  for (let i = from; i < to; i++) {
    if (!/^\s*\|/.test(lines[i])) continue
    const header = splitRow(lines[i])
    if (!lines[i + 1] || !/^\s*\|/.test(lines[i + 1]) || !isSeparator(splitRow(lines[i + 1]))) continue
    const rows = []
    let j = i + 2
    for (; j < to && /^\s*\|/.test(lines[j]); j++) rows.push({ line: j + 1, cells: splitRow(lines[j]) })
    out.push({ header: header.map((h) => clean(h).replace(/\*+/g, '').trim().toLowerCase()), headerLine: i + 1, rows })
    i = j - 1
  }
  return out
}

/** Every heading of `lines`: `{ index (0-based line), level, text }`. The one heading parser of the plugin. */
export const headings = (lines) =>
  lines.flatMap((l, index) => {
    const m = l.match(/^(#{1,6})\s+(.*?)\s*$/)
    return m ? [{ index, level: m[1].length, text: m[2] }] : []
  })

/** The body of heading `h` of `heads`: 0-based line bounds `{ from, to }`, to the next heading of the same or a higher level. */
export const bodyOf = (heads, h, total) => {
  const next = heads.find((n) => n.index > h.index && n.level <= h.level)
  return { from: h.index + 1, to: next ? next.index : total }
}

/** The first heading whose text matches `re`: `{ line, from, to }`, from/to are 0-based line bounds of its body. */
export const section = (lines, re) => {
  const heads = headings(lines)
  const h = heads.find((x) => re.test(x.text))
  if (!h) return null
  return { line: h.index + 1, ...bodyOf(heads, h, lines.length) }
}

/** The tables of the "App repos" section of a PROJECT.md text (visible lines only: not in a comment or a code block). */
const appTables = (text) => {
  const lines = visibleLines(text)
  const s = section(lines, /^app repos$/i)
  return s ? tables(lines, s.from, s.to) : []
}
/** App repos header names, tolerant: `Repo` / `Name` for the app, any header with "path" (but not `task_path`) for its local path, `task_path`, `What...`. `**` is stripped by `tables`. */
const APP_COLS = { repo: /^(repo|name)\b/, label: /^label\b/, path: /^(?!.*task)(.*\bpath\b|path\b.*)/, taskPath: /^task[_ ]?path/, what: /^what/ }

/** The rows of the "App repos" table of a PROJECT.md text: `{ repo, label, path, taskPath, what }`, cells cleaned; `label` is the optional Label column (what a ticket's `[FE <app>]` names), empty when the column or the cell is. One reader for the lint and doctor. */
export const appRepos = (text) =>
  appTables(text)
    .filter((t) => col(t.header, APP_COLS.repo) >= 0)
    .flatMap((t) => {
      const at = (key) => col(t.header, APP_COLS[key])
      const cell = (r, i) => (i < 0 ? '' : clean(r.cells[i]))
      return t.rows.map((r) => ({ repo: cell(r, at('repo')), label: emptyish(cell(r, at('label'))) ? '' : cell(r, at('label')), path: cell(r, at('path')), taskPath: cell(r, at('taskPath')), what: cell(r, at('what')) }))
    })

/**
 * The rows of the "Service repos" table of a PROJECT.md text, read from the visible lines (a table in a comment or a code block is not declared):
 * `{ name, path, clone }` with the cells as written (a backtick inside is for the clone checks to refuse, not for `clean` to drop), trimmed; rows with an empty name are left out.
 * Columns are by position: Repo, Local path, Clone source (as templates/PROJECT.md). One reader for the doctor and clone.mjs.
 */
export const serviceRepos = (text) => {
  const lines = visibleLines(text)
  const s = section(lines, /^service repos$/i)
  const t = s ? tables(lines, s.from, s.to)[0] : null
  return (t?.rows ?? []).map((r) => ({ name: (r.cells[0] ?? '').trim(), path: (r.cells[1] ?? '').trim(), clone: (r.cells[2] ?? '').trim() })).filter((r) => !emptyish(r.name))
}

/**
 * The apps a name can mean, in tiers: a ticket's `[FE <app>]` is matched by Label first, then by repo name; a `--repo` value by repo name first, then by Label (`repoFirst`).
 * The first tier that has a match wins; more than one row in it is an ambiguity the caller must report. `[]` when nothing matches. Names are compared loosely (`normName`).
 */
export const findApps = (apps, name, { repoFirst = false } = {}) => {
  const byLabel = apps.filter((a) => a.label && normName(a.label) === normName(name))
  const byRepo = apps.filter((a) => normName(a.repo) === normName(name))
  const [first, second] = repoFirst ? [byRepo, byLabel] : [byLabel, byRepo]
  return first.length ? first : second
}

/** The one app a name means, or undefined when none or several (`findApps` tells which). */
export const findApp = (apps, name, opts) => {
  const found = findApps(apps, name, opts)
  return found.length === 1 ? found[0] : undefined
}

/** Rows of App repos that share a Label or a repo name (compared loosely): `[{ name, repos }]`, for the lint and doctor. */
export const duplicateAppNames = (apps) => {
  const out = []
  for (const [kind, of] of [['Label', (a) => a.label], ['repo name', (a) => a.repo]]) {
    const groups = new Map()
    for (const a of apps) if (of(a)) groups.set(normName(of(a)), [...(groups.get(normName(of(a))) ?? []), a])
    for (const rows of groups.values()) if (rows.length > 1) out.push({ kind, name: of(rows[0]), repos: rows.map((r) => r.repo) })
  }
  return out
}

/** The names an app can be called by in a ticket, for a message: `Label` (repo `x`) or just the repo name. */
export const appNames = (apps) => apps.map((a) => (a.label && normName(a.label) !== normName(a.repo) ? `${a.label} (repo ${a.repo})` : a.repo)).join(', ') || 'none'

/** Why the App repos table cannot be read, or null: a table is there but lacks the app-name column or the path column (an empty or absent table is "unfilled", not this). */
export const appReposProblem = (text) => {
  const found = appTables(text)
  if (!found.length || found.some((t) => col(t.header, APP_COLS.repo) >= 0 && col(t.header, APP_COLS.path) >= 0)) return null
  const t = found[0]
  const lacks = [col(t.header, APP_COLS.repo) < 0 ? 'Repo (or Name)' : null, col(t.header, APP_COLS.path) < 0 ? 'Path' : null].filter(Boolean)
  return `App repos: the table has no ${lacks.join(' and no ')} column (found: ${t.header.join(', ') || 'none'})`
}

/** Index of the first header cell matching `re`, or -1. */
export const col = (header, re) => header.findIndex((h) => re.test(h))

/** A list item (`-`, `*`, `1.`, `1)`): group 2 is its text. */
export const LIST_ITEM = /^\s*([-*]|\d+[.)])\s+(.*)$/
/** A name compared loosely: backticks, case, spaces and punctuation ignored (`Guest app` = `guest-app`). */
export const normName = (v) => clean(v).toLowerCase().replace(/[^a-z0-9]/g, '')
/** The one list item that says "nothing here" in a handoff section: the lint (`emptyish`) and the handoff script both use it. */
export const EMPTY_ITEM = '- none'

/**
 * `{ rest }` when the line is a label of the form `**Word**`, `**Word:** text`, `Word:` or `## Word`; prose that merely starts with the word is not a label.
 * `word` is a regex source without capture groups.
 */
export const labelOf = (line, word) => {
  const m = line.match(new RegExp(`^\\s*(#+\\s+)?(\\*\\*|__)?\\s*${word}\\b\\s*(\\*\\*|__)?\\s*(:)?\\s*(\\*\\*|__)?\\s*(.*)$`, 'i'))
  if (!m || !(m[1] || m[2] || m[4])) return null
  return { rest: m[4] ? m[6].trim() : '' }
}

/** A criterion: one line WHEN <condition> THEN <result>. The one check of the jira lint, the handoff lint and the handoff script. */
export const WHEN_THEN = /\bWHEN\s+\S.*\bTHEN\s+\S/
export const isCriterion = (text) => WHEN_THEN.test(text)
/** A separator line (`---`, `***`, `___`): it ends the block above it. */
export const DIVIDER = /^\s*([-*_])(\s*\1){2,}\s*$/

/** A `## Heading` of a template and a `Field:` line of its header: the one form of the handoff template's shape, read by the lint and the handoff script. */
export const SECTION_HEADING = /^##\s+(.+?)\s*$/
export const FIELD_LINE = /^([A-Z][\w/ ]*):/
const MARKER_LINE = /^<!--\s*product-handoff \d+\s*-->$/

/** The shape of a template with a version marker on line 1: `{ marker, fields, sections }`, or null when the marker, the header fields or the sections cannot be read. */
export const templateShape = (text) => {
  const raw = text?.split('\n') ?? []
  const lines = visibleLines(text ?? '')
  const firstSection = lines.findIndex((l) => /^##\s/.test(l))
  const fields = lines.slice(0, firstSection < 0 ? lines.length : firstSection).flatMap((l) => l.match(FIELD_LINE)?.[1] ?? [])
  const sections = lines.flatMap((l) => l.match(SECTION_HEADING)?.[1] ?? [])
  if (!MARKER_LINE.test((raw[0] ?? '').trim()) || !fields.length || !sections.length) return null
  return { marker: raw[0].trim(), fields, sections }
}
