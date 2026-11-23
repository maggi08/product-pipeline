/**
 * Where the product repo and its app repos are: the one search for PROJECT.md, the file reader, the path rules, and the task folder
 * of an app repo. Shared by doctor, the lint and the handoff. Node 22, no dependencies.
 */
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appRepos, emptyish } from './markdown.mjs'

/** The product-repo contract the lint reads its id table from. */
export const CONTRACT_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../references/product-repo.md')

/** The directory that holds PROJECT.md: `dir` itself, then each parent up to the filesystem root; null when there is none. */
export const findProject = (dir) => {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, 'PROJECT.md'))) return d
    if (dirname(d) === d) return null
  }
}

/** The largest file the scripts read (a product file is a few KB; a bigger one is not read, a /dev/zero link cannot eat memory). */
export const MAX_BYTES = 4 * 1024 * 1024

/** `p` is `base` or inside it (both resolved paths). The one "inside a directory" rule of the plugin: the read bound and the clone target use it. */
export const insideOrSame = (base, p) => {
  const r = relative(base, p)
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r))
}

/**
 * A file's text, or null when it is not there, is not a regular file (a FIFO, a device, a directory), is over MAX_BYTES, or, with `within`,
 * its real path is outside `within` (a symlink that leaves the epic is not followed). Never throws.
 */
export const read = (p, within) => {
  try {
    const st = lstatSync(p)
    if (st.isSymbolicLink() || within) {
      const real = realpathSync(p)
      if (within && !insideOrSame(realpathSync(within), real)) return null
      if (!statSync(real).isFile() || statSync(real).size > MAX_BYTES) return null
    } else if (!st.isFile() || st.size > MAX_BYTES) return null
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/** A file of an epic folder: `read` with the epic as the boundary. */
export const readIn = (epic, rel) => read(join(epic, rel), epic)

/** The App repos rows of the PROJECT.md above the epic folder: `null` when there is none. One reader for the lint and the handoff. */
export const appsOfEpic = (epic) => {
  const root = findProject(epic)
  const text = root ? read(join(root, 'PROJECT.md')) : null
  return text === null ? null : appRepos(text).filter((r) => !emptyish(r.repo))
}

/** The home directory: `$HOME` first (tests and a changed environment), then the account's. The one place that decides it. */
export const homeDir = () => process.env.HOME || homedir()

/** `~` and `~/...` mean the home directory; nothing else is expanded (`~bob/app` stays as written). */
export const expand = (p) => (p.startsWith('~/') || p === '~' ? join(homeDir(), p.slice(1)) : p)

/** The absolute path of an app or service repo from the Path cell of PROJECT.md: relative paths are from the product repo `root`. */
export const appPathOf = (root, path) => (isAbsolute(expand(path)) ? expand(path) : resolve(root, expand(path)))

const TASK_PATH_LINE = /^[ \t]*-[ \t]*task_path:[ \t]*(.+)$/m
/**
 * A `task_path` value read the way stage-pipeline reads it (hooks/pipeline-state.mjs, taskDirFromConfig): the first word, backticks and quotes
 * dropped, cut at `<` (`<TICKET>/`), `~/` and `$HOME/` expanded; an empty value is the default `.claude/tasks`. Returns a path, absolute or relative to the app repo.
 */
export const taskPathValue = (raw) => {
  const path = String(raw).trim().split(/\s+/)[0].replace(/^[`'"]+|[`'"]+$/g, '').split('<')[0]
  if (!path) return '.claude/tasks'
  return path.startsWith('$HOME/') ? join(homeDir(), path.slice(5)) : expand(path)
}

/**
 * The task folder of an app repo and where the value came from: the `task_path` line of the app repo's `.claude/pipeline.config.local.md` over
 * `.claude/pipeline.config.md` (as stage-pipeline reads them), else `.claude/tasks` when the app repo has a config without that line; the PROJECT.md column `columnValue` only when the app repo has no pipeline config at all (not initialized yet), else `.claude/tasks`.
 * `{ taskPath, taskDir, source }`; `taskPath` is the value as normalized, `taskDir` the absolute folder.
 */
export const taskDirOf = (appPath, columnValue) => {
  const configs = ['pipeline.config.local.md', 'pipeline.config.md'].map((n) => read(join(appPath, '.claude', n))).filter((t) => t !== null)
  const raw = configs.join('\n').match(TASK_PATH_LINE)?.[1]
  let value
  let source
  if (raw !== undefined) [value, source] = [taskPathValue(raw), 'the app repo\'s pipeline.config']
  else if (!configs.length && columnValue && !emptyish(columnValue)) [value, source] = [taskPathValue(columnValue), 'the PROJECT.md task_path column']
  else [value, source] = ['.claude/tasks', 'the default']
  return { taskPath: value, taskDir: isAbsolute(value) ? value : resolve(appPath, value), source }
}
