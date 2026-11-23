#!/usr/bin/env node
/**
 * Clones one service repo of PROJECT.md: the command is built here from the Service repos row, checked, printed, and run only with --yes.
 *
 *   node clone.mjs <product repo> <service repo name> [--to <path>] [--yes]
 *
 * - `owner/name` of the Clone source cell must match ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ (the cell `gh repo clone owner/name` of the template is read as that);
 * - the service name is letters, digits, `_`, `.`, `-` (no leading `-` or `.`), checked before anything else;
 * - the path (the Local path cell, or `--to`) must hold no shell character, no segment that starts with `.`, and stay out of the product repo; a relative path with `..` may not leave the folder that holds the product repo; `--to` (or `--to=<path>`) must also be inside the system temporary folder;
 * - without --yes: prints the exact command and exits 0, nothing runs. With --yes: runs `gh` through execFileSync with an argument array, no shell, `--depth 1`.
 * - a refused cell prints the reason (never the cell) and exits 1: nothing was executed.
 * The skill shows the printed command to the user and runs again with --yes only after the user said yes to that command.
 * Exit 0 printed or cloned, 1 refused or `gh` failed, 2 usage. Env for tests: PATH. Node 22, no dependencies.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { cloneCommand, serviceNameOf } from './lib/clone.mjs'
import { clean, serviceRepos } from './lib/markdown.mjs'
import { findProject, readIn } from './lib/project.mjs'

const usage = (msg) => {
  console.error(`clone: ${msg}\nusage: node clone.mjs <product repo> <service repo name> [--to <path>] [--yes]`)
  process.exit(2)
}
const argv = process.argv.slice(2)
let yes = false
let to = null
const pos = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--yes') yes = true
  else if (argv[i] === '--to') to = argv[++i] ?? ''
  else if (argv[i].startsWith('--to=')) to = argv[i].slice(5)
  else if (argv[i].startsWith('--')) usage(`unknown option ${argv[i]}`)
  else pos.push(argv[i])
}
if (pos.length !== 2) usage('give the product repo and the service repo name')
// first of all: the name goes into the command the doctor and the skills print, so it is a plain word or nothing happens
if (!serviceNameOf(pos[1])) {
  console.error('clone: refused — the service name may hold letters, digits, "_", "." and "-" only (no leading "-" or "."), no space or shell character. Nothing was run.')
  process.exit(1)
}
const root = findProject(resolve(pos[0]))
if (!root) usage(`no PROJECT.md in ${resolve(pos[0])} or above`)
const text = readIn(root, 'PROJECT.md')
const rows = serviceRepos(text ?? '')
const row = rows.find((r) => clean(r.name).toLowerCase() === pos[1].toLowerCase())
if (!row) {
  console.error(`clone: PROJECT.md has no service repo "${pos[1]}" (it has: ${rows.map((r) => clean(r.name)).join(', ') || 'none'})`)
  process.exit(1)
}
if (to !== null && existsSync(resolve(to)) && !statSync(resolve(to)).isDirectory()) {
  console.error('clone: --to is a file, not a folder: give a folder that does not exist or is empty')
  process.exit(1)
}
const made = cloneCommand(root, row.clone, to ?? row.path, { tmpOnly: to !== null })
if (!made.ok) {
  console.error(`clone: refused — ${made.reason}. Nothing was run. Correct the Service repos row of PROJECT.md.`)
  process.exit(1)
}
if (existsSync(made.path) && !statSync(made.path).isDirectory()) {
  console.error(`clone: ${made.path} is a file, not a folder: not cloning over it`)
  process.exit(1)
}
if (existsSync(made.path) && readdirSync(made.path).length) {
  console.error(`clone: ${made.path} already exists and is not empty: not cloning over it`)
  process.exit(1)
}
console.log(made.text)
if (!yes) {
  console.log('(not run: show this command to the user and, after their yes, run again with --yes)')
  process.exit(0)
}
try {
  execFileSync('gh', made.args, { stdio: 'inherit' })
} catch (e) {
  console.error(`clone: gh failed${e.status ? ` (exit ${e.status})` : `: ${e.code ?? e.message}`}`)
  process.exit(1)
}
