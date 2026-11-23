#!/usr/bin/env node
/**
 * Is this machine ready for the product pipeline? Read-only: reads PROJECT.md, looks names up on PATH, checks paths.
 *
 *   node doctor.mjs [<product repo>] [--json]
 *
 * - PROJECT.md is present and its required fields are filled (no `<placeholder>` left);
 * - every service repo of PROJECT.md exists locally; a missing one prints the clone command assembled from its row (`owner/name` and the path checked, `lib/clone.mjs`),
 *   never the raw cell; a cell that does not pass is an error that says why;
 * - PROJECT.md is read with bounds (a FIFO, a device or a file over 4 MB is an error); it holds no credential: a PASSWORD/TOKEN/SECRET/KEY-like `NAME=value` (by name segments, bare names included),
 *   `--password x` or a URI with a password is an error (the value is never printed);
 * - a service name that is not letters, digits, `_`, `.`, `-` gets no command in the fix; the clone.mjs line it prints has every argument in POSIX single quotes;
 * - the data route's client and tunnel tool, as declared in PROJECT.md, are found on PATH. Only a lookup of the
 *   command name: nothing from PROJECT.md is executed, no connection is made;
 * - stage-pipeline and human-text are in ~/.claude/plugins/installed_plugins.json (missing: a warning);
 * - Chrome MCP is for retrying a 403 page in the browser (informational: the plugin cannot see MCP servers).
 *
 * Exit 1 only on errors. Env for tests: PRODUCT_DOCTOR_PLUGINS (path of the installed-plugins file), PATH, HOME.
 * Node 22, no dependencies.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { cloneCommand, serviceNameOf, shQuote } from './lib/clone.mjs'
import { appRepos, appReposProblem, clean, duplicateAppNames, emptyish, section, serviceRepos } from './lib/markdown.mjs'
import { appPathOf, expand, findProject, homeDir, read } from './lib/project.mjs'

const args = process.argv.slice(2)
const json = args.includes('--json')
const argDir = args.find((a) => !a.startsWith('--'))
const HOME = homeDir()
const pluginsFile = process.env.PRODUCT_DOCTOR_PLUGINS || join(HOME, '.claude/plugins/installed_plugins.json')

const results = []
const add = (level, name, message, fix) => results.push({ level, name, message, ...(fix ? { fix } : {}) })

/** The name of the executable a declared command starts with: the first word that is not VAR=value (a secret-like one is an error of its own, below). Never run. */
const commandName = (cmd) => clean(cmd).split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? ''

/**
 * A credential in a line of PROJECT.md: `NAME=value` where the name is secret-like by its segments (`PGPASSWORD`, `API_TOKEN`, `password`, `secret = x`, also inside a quoted
 * libpq string), `--password x` / `--token=x`, or `scheme://user:password@host`. A `$VAR` reference, a `<placeholder>` or an empty value is not one. `{ name }` or null; never the value.
 * The name rule follows stage-pipeline's backend-detect (`secretName`), not imported: TOKEN/SECRET/PASSWORD/PASSWD/PASS/PWD as a segment or a suffix in any case; KEY only as the
 * whole name (`key=`), as an upper-case segment or suffix (`API_KEY`) or a camelCase suffix (`apiKey`), never as a word of a lower-case identifier (`sort_key`).
 */
const SECRET_WORDS = new Set(['TOKEN', 'SECRET', 'PASSWORD', 'PASSWD', 'PASS', 'PWD'])
const secretName = (name) => {
  const parts = name.split('_')
  if (parts.some((w) => SECRET_WORDS.has(w.toUpperCase()))) return true
  if (/(?:TOKEN|SECRET|PASSWORD|PASSWD)$/i.test(name)) return true
  if (name.toUpperCase() === 'KEY') return true
  return (name === name.toUpperCase() && (parts.includes('KEY') || /KEY$/.test(name))) || /[a-z]Key$/.test(name)
}
const ASSIGNMENT = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*(\S*)/g
/** A value that is a reference or nothing: `$VAR`, `<placeholder>`, empty, or an empty pair of quotes. */
const notAValue = (v) => /^(?:["']?[$<]|["']?$|["']{2})/.test(v)
const SECRET_FLAG = /(?<![A-Za-z0-9_-])--(?:[a-z]+-)*(password|passwd|pass|token|secret|api-key|apikey)(?:=|\s+)(?!-|\$|<|["']?\$)\S/i
const URI_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/i
const secretIn = (line) => {
  for (const m of line.matchAll(ASSIGNMENT)) if (secretName(m[1]) && !notAValue(m[2])) return { name: m[1] }
  const f = line.match(SECRET_FLAG)
  if (f) return { name: `--${f[1]}` }
  return URI_PASSWORD.test(line) ? { name: 'a URI with a password' } : null
}

/** Install hints for tools whose package name differs from the command. Anything else gets no guessed package. */
const KNOWN = {
  psql: 'brew install libpq (keg-only: add "$(brew --prefix libpq)/bin" to PATH)',
  gcloud: 'brew install --cask gcloud-cli',
  kubectl: 'brew install kubernetes-cli',
}
const installFix = (bin) => (KNOWN[bin] ? `${KNOWN[bin]}` : `install the package that provides ${bin || 'the tool'}`)

/** PATH lookup in JS, no shell and no `which`. */
const onPath = (bin, base) => {
  if (!bin || /[\0]/.test(bin)) return false
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : ['']
  const dirs = bin.includes('/') || bin.includes('\\') ? [''] : (process.env.PATH || '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = (dir ? join(dir, bin) : resolve(base, expand(bin))) + ext
      try {
        if (!statSync(file).isFile()) continue
        accessSync(file, constants.X_OK)
        return true
      } catch {
        // not here
      }
    }
  }
  return false
}

// find PROJECT.md: the given directory or the current one, then its parents to the filesystem root
const start = resolve(argDir ?? process.cwd())
const root = findProject(start)

/** The body lines of the first heading matching `re` (any level), or none. */
const body = (lines, re) => {
  const s = section(lines, re)
  return s ? lines.slice(s.from, s.to) : []
}
const bullet = (lines, label) => {
  const v = lines.map((l) => l.match(new RegExp(`^-\\s*${label}:\\s*(.*)$`, 'i'))?.[1]).find((x) => x !== undefined)
  return v === undefined ? v : clean(v)
}

if (!root) {
  add('error', 'PROJECT.md', `no PROJECT.md in ${start} or above`, 'run /product to create the product repo, or pass the path: node doctor.mjs <product repo>')
} else project: {
  const text = read(join(root, 'PROJECT.md')) // bounded: a FIFO, a device or a file over 4 MB is not read
  if (text === null) {
    add('error', 'PROJECT.md', `${join(root, 'PROJECT.md')} is not a regular file or is larger than 4 MB`, 'replace it with the PROJECT.md of templates/PROJECT.md (a plain file)')
    break project
  }
  const lines = text.split('\n')
  const missing = []
  if (emptyish(text.match(/^Product repo:\s*(.*)$/m)?.[1])) missing.push('Product repo')
  const apps = appRepos(text).filter((r) => !emptyish(r.repo) && !emptyish(r.path))
  const appsProblem = apps.length ? null : appReposProblem(text)
  if (!apps.length && !appsProblem) missing.push('App repos (one row)')
  for (const label of ['Chat', 'Epic files', 'Stakeholder documents']) if (emptyish(bullet(body(lines, /^languages$/i), label))) missing.push(`Languages: ${label}`)
  if (emptyish(bullet(body(lines, /^documents$/i), 'Publish to'))) missing.push('Documents: Publish to')
  lines.forEach((l, i) => {
    const hit = secretIn(l)
    if (hit) add('error', 'PROJECT.md', `${join(root, 'PROJECT.md')}:${i + 1} holds a credential (${hit.name}; the value is not shown)`, 'move it out of PROJECT.md: the route names the client, the tunnel and the database role only; the password or token stays in the user\'s own environment or ~/.pgpass')
  })
  if (missing.length) add('error', 'PROJECT.md', `${join(root, 'PROJECT.md')} has unfilled fields: ${missing.join('; ')}`, 'fill them in PROJECT.md (templates/PROJECT.md shows each field), or run /product and answer the questions')
  else if (!appsProblem) add('ok', 'PROJECT.md', `${join(root, 'PROJECT.md')}: required fields filled`)
  if (appsProblem) add('error', 'PROJECT.md', `${join(root, 'PROJECT.md')} ${appsProblem}`, 'name the columns Repo (or Name) and Path, as templates/PROJECT.md does')

  // app repos: each declared path exists on this machine (a repo that is not cloned is a failure of the handoff later, not of the lint)
  const named = appRepos(text).filter((r) => !emptyish(r.repo))
  for (const d of duplicateAppNames(named)) add('error', 'app repos', `the ${d.kind} "${d.name}" is on more than one row of App repos in PROJECT.md (${d.repos.join(', ')})`, 'give each app its own Label and repo name: a ticket\'s [FE <app>] must name one app')
  for (const a of named) {
    if (emptyish(a.path)) {
      add('error', `app repo ${a.repo}`, 'not found locally (no path in PROJECT.md)', 'write its local path into the Path column of App repos in PROJECT.md')
      continue
    }
    const dir = appPathOf(root, a.path)
    if (existsSync(dir)) add('ok', `app repo ${a.repo}`, dir)
    else add('error', `app repo ${a.repo}`, `not found locally: ${dir}`, `clone it and write its local path into the Path column of App repos in PROJECT.md (or correct the path if the repo lives elsewhere)`)
  }

  // service repos
  const services = serviceRepos(text)
  if (!services.length) add('info', 'service repos', 'PROJECT.md declares none: discovery will not make claims about backend code')
  for (const sv of services) {
    const name = clean(sv.name)
    const [path, clone] = [clean(sv.path), clean(sv.clone)]
    const dir = appPathOf(root, path)
    if (!emptyish(path) && existsSync(dir)) add('ok', `service repo ${name}`, dir)
    else {
      // the fix is the command assembled from the checked cells, never the raw cell; the name is quoted as an argument
      const made = emptyish(clone) || emptyish(path) ? null : cloneCommand(root, sv.clone, sv.path)
      const fix = !serviceNameOf(name)
        ? 'the service name in PROJECT.md may hold letters, digits, "_", "." and "-" only (no leading "-" or "."): correct the Repo cell, nothing was run'
        : emptyish(clone)
          ? `clone it and write its local path into PROJECT.md (no clone source is declared for ${name})`
          : emptyish(path)
            ? `write the local path of ${name} into PROJECT.md, then clone it`
            : made.ok
              ? `${made.text}  (after the user's yes: node ${shQuote(join(import.meta.dirname, 'clone.mjs'))} <product repo> ${shQuote(name)} --yes)`
              : `the Clone source or Local path of ${name} in PROJECT.md is refused (${made.reason}): correct the row, nothing was run`
      add('error', `service repo ${serviceNameOf(name) ? name : 'with an invalid name'}`, `not found locally${emptyish(path) ? ' (no path in PROJECT.md)' : `: ${dir}`}`, fix)
    }
  }

  // data route: only the declared command names
  const route = body(lines, /^data route$/i)
  const client = bullet(route, 'Client')
  const tunnel = bullet(route, 'Tunnel command')
  if (emptyish(client) && emptyish(tunnel)) add('info', 'data route', 'none declared in PROJECT.md: data requests will be answered by someone who has access')
  else {
    for (const [label, value] of [['client', client], ['tunnel tool', tunnel]]) {
      if (emptyish(value)) continue
      const bin = commandName(value.split('|')[0])
      if (onPath(bin, root)) add('ok', `data route ${label}`, `${bin} found on PATH`)
      else add('error', `data route ${label}`, `${bin || value} is declared in PROJECT.md but not on PATH`, `${installFix(bin)}, or correct the ${label === 'client' ? 'Client' : 'Tunnel command'} line in PROJECT.md`)
    }
  }
}

// companion plugins
let installed = null
try {
  const data = JSON.parse(readFileSync(pluginsFile, 'utf8'))
  installed = Object.keys(data.plugins ?? data ?? {})
} catch {
  // no readable file: every plugin below is reported as not found
}
for (const [name, role, install] of [
  ['stage-pipeline', 'current UI state (/feature-checker) and the handoff target (/stage-plan)', 'claude plugin install stage-pipeline@magzhan'],
  ['human-text', 'stakeholder messages and the published brief', 'claude plugin install human-text@magzhan'],
]) {
  if (installed?.some((k) => k === name || k.startsWith(`${name}@`))) add('ok', name, `installed — ${role}`)
  else add('warn', name, `not installed${installed ? '' : ` (${pluginsFile} not readable)`} — ${role}; the steps still work without it`, install)
}

add('info', 'Chrome MCP', 'used to retry a vendor page that answers 403 to fetch; the doctor cannot see MCP servers — if the retry fails, connect claude-in-chrome or chrome-devtools (/mcp)')

const errors = results.filter((r) => r.level === 'error').length
if (json) console.log(JSON.stringify({ root, errors, warnings: results.filter((r) => r.level === 'warn').length, checks: results }, null, 2))
else {
  const tag = { ok: 'ok     ', info: 'info   ', warn: 'warning', error: 'ERROR  ' }
  for (const r of results) {
    console.log(`${tag[r.level]} ${r.name} — ${r.message}`)
    if (r.fix) console.log(`        fix: ${r.fix}`)
  }
  console.log(errors ? `\n${errors} error(s): fix them before /product-discovery` : '\nno errors')
}
process.exit(errors ? 1 : 0)
