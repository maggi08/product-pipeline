/**
 * The clone command of a service repo, built from the cells of PROJECT.md and checked: the one place that decides what a cell may become.
 * A cell is never run and never printed back as a command: `cloneCommand` returns an argument array for `gh` (no shell) and the text shown to the user.
 * Node 22, no dependencies.
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, resolve } from 'node:path'
import { expand, insideOrSame } from './project.mjs'

/** `owner/name` of GitHub: letters, digits, `_`, `.`, `-` on both sides of one slash. */
export const OWNER_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
/** The characters a path cell may hold: no `$`, backtick, `;`, `|`, `&`, quote, redirect, brace, backslash, newline or any other shell syntax. */
export const SAFE_PATH = /^[A-Za-z0-9_.\/~+@ -]+$/

/** A cell's text with one wrapping pair of backticks (markdown code) removed; a backtick left inside is a character the checks below refuse. */
const unwrap = (cell) => {
  const t = String(cell ?? '').replace(/\\\|/g, '|').trim()
  return t.match(/^`([^`]*)`$/)?.[1].trim() ?? t
}

/** A service name as clone.mjs and the doctor's printed command take it: letters, digits, `_`, `.`, `-`; no leading `-` (an option) or `.`; no shell syntax, no space. */
export const SERVICE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/
/** The service name as `SERVICE_NAME` allows it, or null. */
export const serviceNameOf = (name) => (SERVICE_NAME.test(String(name ?? '')) ? String(name) : null)
/** A POSIX single-quoted argument: what the doctor prints so that pasting the line cannot run anything. */
export const shQuote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`

/** The real path of tmpdir() and its plain spelling (macOS: /var is /private/var): the places `--to` may point into. */
const tmpAreas = () => {
  const t = resolve(tmpdir())
  try {
    return [t, realpathSync(t)]
  } catch {
    return [t]
  }
}

/** The `owner/name` a clone-source cell stands for: the bare `owner/name` or `gh repo clone owner/name` (what the template shows), nothing else. */
export const ownerNameOf = (cell) => {
  const v = unwrap(cell).replace(/^gh repo clone\s+/, '')
  return OWNER_NAME.test(v) && !/^[-.]/.test(v) && !/(^|\/)\.{1,2}$/.test(v) ? v : null
}

/**
 * `{ ok: true, args, path, text }` or `{ ok: false, reason }`. `args` is the argument array for `gh`; `text` is the command shown to the user (the path in single quotes).
 * `root` is the product repo (relative paths are from it). The path: no shell characters; with `..` only a relative path that stays in the product repo's parent folder,
 * never an absolute one; not inside the product repo; no segment that starts with `.` (a hidden folder such as ~/.claude or ~/.ssh).
 * `tmpOnly` (the `--to` form): the target must be inside the system temporary folder. `reason` never carries the raw cell.
 */
export const cloneCommand = (root, cloneCell, pathCell, { tmpOnly = false } = {}) => {
  const ownerName = ownerNameOf(cloneCell)
  if (!ownerName) return { ok: false, reason: 'the clone source is not owner/name (or "gh repo clone owner/name"): letters, digits, "_", "." and "-" only' }
  const raw = unwrap(pathCell)
  if (!raw || !SAFE_PATH.test(raw)) return { ok: false, reason: 'the path has a character a path of PROJECT.md may not have (shell characters such as $ ` ; | & quotes, a newline) or is empty' }
  if (raw.startsWith('-')) return { ok: false, reason: 'the path starts with "-"' }
  const segments = raw.split('/')
  if (segments.some((g) => g.startsWith('.') && g !== '.' && g !== '..')) return { ok: false, reason: 'the path has a segment that starts with "." (a hidden folder): a service repo is not cloned into one' }
  const target = resolve(root, expand(raw))
  if (segments.includes('..')) {
    if (isAbsolute(expand(raw)) || !insideOrSame(dirname(resolve(root)), target)) return { ok: false, reason: 'the path leaves the folder that holds the product repo with ".."' }
  }
  if (insideOrSame(resolve(root), target)) return { ok: false, reason: 'the path is inside the product repo: a service repo is cloned next to it' }
  if (tmpOnly && !tmpAreas().some((a) => insideOrSame(a, target))) return { ok: false, reason: 'a --to path must be inside the system temporary folder' }
  const args = ['repo', 'clone', ownerName, target, '--', '--depth', '1']
  return { ok: true, args, path: target, text: `gh repo clone ${ownerName} ${shQuote(target)} -- --depth 1` }
}
