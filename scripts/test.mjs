#!/usr/bin/env node
/**
 * Fixture tests for the plugin's scripts: each check must pass a clean copy of the plugin and catch a planted defect.
 *
 *   node scripts/test.mjs
 *
 * Temporary copies only; nothing in this checkout is touched. Node 22, no dependencies.
 * Each script's fixtures follow, with the same `check` / `run` shape.
 */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findTicket, readJira } from './lib/jira.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0
const check = (name, ok, out = '') => {
  console.log(`${ok ? '✔' : '✘'} ${name}`)
  if (!ok) {
    failed++
    console.log(String(out).split('\n').map((l) => `    ${l}`).join('\n'))
  }
}
const run = (script, ...args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

// a copy of the plugin without git history and local files; validate.mjs resolves its root from its own location
const copy = () => {
  const dir = mkdtempSync(join(tmpdir(), 'product-plugin-'))
  cpSync(ROOT, dir, { recursive: true, filter: (src) => !/[\\/](\.git|\.claude|node_modules)$/.test(src) })
  return dir
}
/** A template line replaced by a fixture value; a renamed line in the template fails the test loudly. */
const fill = (text, pattern, value, what) => {
  if (!pattern.test(text)) throw new Error(`templates/${what} has no line matching ${pattern}`)
  return text.replace(pattern, value)
}
const edit = (dir, path, fn) => writeFileSync(join(dir, path), fn(readFileSync(join(dir, path), 'utf8')))

// the strings below are assembled so this file itself stays clean for validate.mjs
const CYR = String.fromCharCode(0x442, 0x435, 0x441, 0x442)
const LINK = '$' + '{CLAUDE_PLUGIN_ROOT}/references/missing-file.md'
const KEY = 'ABC' + '-123'
const HK = (n) => `${'ABC'}-${n}`
const SKILL = 'skills/product/SKILL.md'

// validate: a clean copy passes, each planted defect fails with file:line
{
  const clean = copy()
  const ok = run(join(clean, 'scripts/validate.mjs'))
  check('validate: a clean copy passes', ok.code === 0, ok.out)
  rmSync(clean, { recursive: true, force: true })
}
const defects = [
  ['validate: Cyrillic outside the RU triggers tail fails', SKILL, (s) => `${s}\n${CYR} outside the tail\n`, new RegExp(`${SKILL}:\\d+: Cyrillic outside`)],
  ['validate: a ticket-shaped id fails', 'references/product-repo.md', (s) => `${s}\nSee ${KEY} for details.\n`, new RegExp(`references/product-repo\\.md:\\d+: ticket id .${KEY}.`)],
  ['validate: a link to a missing plugin file fails', SKILL, (s) => `${s}\nRead ${LINK} first.\n`, new RegExp(`${SKILL}:\\d+: link to a missing`)],
  ['validate: a README count off by one fails', 'README.md', (s) => s.replace(/The plugin has 9 skills and 1 agent/, 'The plugin has 10 skills and 1 agent'), /README\.md:\d+: says .10 skills., the plugin has 9/],
  ['validate: a CHANGELOG top that differs from the version fails', 'CHANGELOG.md', (s) => s.replace(/^## \d+\.\d+\.\d+/m, '## 9.9.9'), /CHANGELOG\.md: the top section is 9\.9\.9/],
  ['validate: a skill name that differs from its folder fails', SKILL, (s) => s.replace(/^name: product$/m, 'name: products'), new RegExp(`${SKILL}: name "products"`)],
  ['validate: a link into ~/.claude/skills fails', 'references/product-repo.md', (s) => `${s}\nSee ~/.claude/skills/x/SKILL.md\n`, /references\/product-repo\.md:\d+: link to ~\/\.claude/],
  ['validate: a ticket-shaped id in another script fails', 'scripts/doctor.mjs', () => `// see ${KEY}\n`, new RegExp(`scripts/doctor\\.mjs:\\d+: ticket id .${KEY}.`)],
  ['validate: a skill over the 30 KB budget fails', SKILL, (s) => `${s}\n${'x'.repeat(31 * 1024)}\n`, new RegExp(`${SKILL}: [\\d.]+ KB over the 30 KB budget`)],
  ['validate: a skill with an empty description fails', SKILL, (s) => s.replace(/^description:.*$/m, 'description:'), new RegExp(`${SKILL}: no description`)],
  ['validate: an empty template file fails', 'templates/EMPTY.md', () => '', /templates\/EMPTY\.md: empty file/],
  ['validate: an empty reference file fails', 'references/EMPTY.md', () => '\n', /references\/EMPTY\.md: empty file/],
  ['validate: an agent with a disallowed tool fails', 'agents/x.md', () => '---\nname: x\ndescription: d\ntools: Read, Edit\n---\nbody\n', /agents\/x\.md: tool Edit is not allowed/],
]
for (const [name, path, fn, pattern] of defects) {
  const dir = copy()
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  if (!existsSync(join(dir, path))) writeFileSync(join(dir, path), '')
  edit(dir, path, fn)
  const got = run(join(dir, 'scripts/validate.mjs'))
  check(name, got.code !== 0 && pattern.test(got.out), got.out)
  rmSync(dir, { recursive: true, force: true })
}
{
  const dir = copy()
  rmSync(join(dir, 'templates'), { recursive: true, force: true })
  const got = run(join(dir, 'scripts/validate.mjs'))
  check('validate: a missing templates/ directory fails', got.code !== 0 && /templates: missing/.test(got.out), got.out)
  rmSync(dir, { recursive: true, force: true })
}
{
  const dir = copy()
  rmSync(join(dir, 'references'), { recursive: true, force: true })
  const got = run(join(dir, 'scripts/validate.mjs'))
  check('validate: a missing references/ directory fails', got.code !== 0 && /references: missing/.test(got.out), got.out)
  rmSync(dir, { recursive: true, force: true })
}

// doctor: fixtures with a product repo in a temp dir; PATH and the installed-plugins file are ours
{
  const dir = mkdtempSync(join(tmpdir(), 'product-doctor-'))
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const tool = (name) => {
    // a stub leaves a trace when it is executed: doctor must only look the name up
    writeFileSync(join(bin, name), `#!/bin/sh\necho ran > '${join(dir, `ran-${name}`)}'\nexit 0\n`)
    chmodSync(join(bin, name), 0o755)
  }
  const plugins = join(dir, 'plugins.json')
  const none = join(dir, 'none.json')
  writeFileSync(plugins, JSON.stringify({ plugins: { 'stage-pipeline@magzhan': [{}], 'human-text@magzhan': [{}] } }))
  writeFileSync(none, JSON.stringify({ plugins: {} }))
  const present = join(dir, 'billing')
  mkdirSync(present)
  mkdirSync(join(dir, 'dashboard'))
  // the full fixture is the shipped template with its placeholders filled: a renamed field in the template breaks a test
  const template = readFileSync(join(ROOT, 'templates/PROJECT.md'), 'utf8')
  const projectMd = (services, client = 'psql') => {
    let t = template
    t = fill(t, /^Product repo:.*$/m, `Product repo: ${join(dir, 'acme-product')}`, 'PROJECT.md')
    t = fill(t, /^\| <dashboard> \|.*$/m, `| dashboard | ${join(dir, 'dashboard')} | .claude/tasks/ | web app |`, 'PROJECT.md')
    t = fill(t, /^\| <billing-service> \|.*$/m, services, 'PROJECT.md')
    t = fill(t, /^- Client:.*$/m, `- Client: ${client}`, 'PROJECT.md')
    t = fill(t, /^- Tunnel command:.*$/m, `- Tunnel command: FOO=1 tunneltool --port 5432; echo x > ${join(dir, 'pwned')}`, 'PROJECT.md')
    t = fill(t, /^- Chat:.*$/m, '- Chat: en', 'PROJECT.md')
    t = fill(t, /^- Epic files:.*$/m, '- Epic files: en', 'PROJECT.md')
    t = fill(t, /^- Stakeholder documents:.*$/m, '- Stakeholder documents: en', 'PROJECT.md')
    t = fill(t, /^- Publish to:.*$/m, '- Publish to: file', 'PROJECT.md')
    return t
  }
  const repo = (services, client) => {
    mkdirSync(join(dir, 'acme-product'), { recursive: true })
    writeFileSync(join(dir, 'acme-product/PROJECT.md'), projectMd(services, client))
    return join(dir, 'acme-product')
  }
  const doctor = (repoDir, pluginFile, ...extra) => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts/doctor.mjs'), repoDir, ...extra], { encoding: 'utf8', env: { PATH: bin, HOME: dir, PRODUCT_DOCTOR_PLUGINS: pluginFile } })
    return { code: r.status, out: r.stdout + r.stderr }
  }
  const services = `| billing | ${present} | gh repo clone acme/billing |\n| payments | ${join(dir, 'payments-missing')} | gh repo clone acme/payments |`

  // a missing service repo and an absent data client: both lines with the fix, exit 1
  let r = doctor(repo(services), plugins)
  check('doctor: a missing service repo prints the clone command, exit 1', r.code === 1 && /ERROR\s+service repo payments/.test(r.out) && /fix: gh repo clone acme\/payments/.test(r.out), r.out)
  check('doctor: an absent data client prints the install fix', /ERROR\s+data route client — psql is declared in PROJECT\.md but not on PATH/.test(r.out) && /fix: brew install libpq/.test(r.out), r.out)
  check('doctor: the present service repo is ok', /ok\s+service repo billing/.test(r.out), r.out)

  // complete fixture: tools on PATH, all repos there
  tool('psql')
  tool('tunneltool')
  r = doctor(repo(`| billing | ${present} | gh repo clone acme/billing |`), plugins)
  check('doctor: a complete fixture exits 0', r.code === 0 && /no errors/.test(r.out) && !/ERROR/.test(r.out), r.out)
  check('doctor: the tunnel value is looked up by name, never executed', /tunneltool found on PATH/.test(r.out) && !existsSync(join(dir, 'pwned')) && !readdirSync(dir).some((f) => f.startsWith('ran-')), r.out)

  // table parsing: aligned separators, backticked paths, a relative tool path resolved from the product repo
  mkdirSync(join(dir, 'parse/scripts'), { recursive: true })
  writeFileSync(join(dir, 'parse/scripts/tunnel.sh'), '#!/bin/sh\nexit 0\n')
  chmodSync(join(dir, 'parse/scripts/tunnel.sh'), 0o755)
  const parseMd = projectMd(`| billing | \`${present}\` | gh repo clone acme/billing |`).replace('|---|---|---|', '|:---|:---:|---:|').replace(/^- Tunnel command:.*$/m, '- Tunnel command: `./scripts/tunnel.sh`')
  writeFileSync(join(dir, 'parse/PROJECT.md'), parseMd)
  r = doctor(join(dir, 'parse'), plugins)
  check('doctor: aligned separators, backticked paths and a relative tool path are read', r.code === 0 && /ok\s+service repo billing/.test(r.out) && /ok\s+data route tunnel tool/.test(r.out) && !/:---/.test(r.out), r.out)

  // no stage-pipeline and no human-text: warnings, exit 0
  r = doctor(join(dir, 'acme-product'), none)
  check('doctor: missing stage-pipeline and human-text are warnings, exit 0', r.code === 0 && /warning\s+stage-pipeline/.test(r.out) && /warning\s+human-text/.test(r.out), r.out)
  check('doctor: the Chrome MCP note is informational', /info\s+Chrome MCP/.test(r.out), r.out)

  // --json
  r = doctor(join(dir, 'acme-product'), none, '--json')
  let parsed = null
  try {
    parsed = JSON.parse(r.out)
  } catch {
    // reported below
  }
  check('doctor: --json is valid JSON with error and warning counts', parsed && parsed.errors === 0 && parsed.warnings === 2 && Array.isArray(parsed.checks), r.out)

  // an unfilled template and a missing PROJECT.md
  mkdirSync(join(dir, 'blank'))
  cpSync(join(ROOT, 'templates/PROJECT.md'), join(dir, 'blank/PROJECT.md'))
  r = doctor(join(dir, 'blank'), plugins)
  check('doctor: the unfilled PROJECT.md template is an error naming the fields', r.code === 1 && /ERROR\s+PROJECT\.md.*unfilled fields: .*Product repo.*App repos.*Languages: Chat.*Languages: Epic files.*Languages: Stakeholder documents.*Documents: Publish to/.test(r.out), r.out)
  mkdirSync(join(dir, 'empty'))
  r = doctor(join(dir, 'empty'), plugins)
  check('doctor: no PROJECT.md is an error with the fix', r.code === 1 && /no PROJECT\.md/.test(r.out) && /fix:/.test(r.out), r.out)
  // one placeholder vocabulary with the lint (scripts/lib/markdown.mjs): "tbd" is no value
  mkdirSync(join(dir, 'tbd'))
  writeFileSync(join(dir, 'tbd/PROJECT.md'), projectMd(`| billing | ${present} | gh repo clone acme/billing |`).replace(/^- Publish to:.*$/m, '- Publish to: tbd'))
  r = doctor(join(dir, 'tbd'), plugins)
  check('doctor: "Publish to: tbd" counts as unfilled', r.code === 1 && /unfilled fields: Documents: Publish to/.test(r.out), r.out)
  // the shared parser reads what the old doctor read: short and aligned separators, a pipe inside a cell, a backticked placeholder
  // an unfilled App repos with the shortest separators must stay unfilled, with no phantom service row
  const unfilled = (name, sep) => {
    mkdirSync(join(dir, name))
    const md = template.replace(/^\|[ -:|]*---[ -:|]*\|$/gm, sep).replace(/^- Chat:.*$/m, '- Chat: en').replace(/^- Epic files:.*$/m, '- Epic files: en').replace(/^- Stakeholder documents:.*$/m, '- Stakeholder documents: en').replace(/^- Publish to:.*$/m, '- Publish to: file').replace(/^Product repo:.*$/m, 'Product repo: /x/acme-product')
    writeFileSync(join(dir, name, 'PROJECT.md'), md)
    return doctor(join(dir, name), plugins)
  }
  for (const sep of ['|:--|:-:|--:|', '|--|--|--|', '|-|-|-|']) {
    r = unfilled(`unfilled-${sep.length}-${sep.charCodeAt(1)}`, sep)
    check(`doctor: an unfilled App repos with separator ${sep} stays unfilled, no phantom service row`, r.code === 1 && /unfilled fields: App repos/.test(r.out) && !/service repo/.test(r.out.replace(/service repos/g, '')), r.out)
  }
  // short separators in a filled file: the tables are still tables
  for (const sep of ['|:--|:-:|--:|', '|--|--|--|']) {
    const name = `short-${sep.charCodeAt(1)}${sep.length}`
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, name, 'PROJECT.md'), projectMd(`| billing | ${present} | gh repo clone acme/billing |`).replace(/^\|---\|---\|---\|$/m, sep).replace(/^\|---\|---\|---\|---\|$/gm, `${sep}--|`))
    r = doctor(join(dir, name), plugins)
    check(`doctor: separator ${sep} is a separator: the filled tables are read`, /required fields filled/.test(r.out) && /ok\s+service repo billing/.test(r.out), r.out)
  }
  mkdirSync(join(dir, 'pipe'))
  writeFileSync(join(dir, 'pipe/PROJECT.md'), projectMd(`| billing | ${present} | gh repo clone acme/billing \\| tee log |`).replace(/^Product repo:.*$/m, 'Product repo: `<path>`'))
  r = doctor(join(dir, 'pipe'), plugins)
  check('doctor: a backticked placeholder counts as unfilled', /unfilled fields: Product repo/.test(r.out), r.out)
  mkdirSync(join(dir, 'pipe2'))
  writeFileSync(join(dir, 'pipe2/PROJECT.md'), projectMd(`| payments | ${join(dir, 'payments-missing')} | gh repo clone acme/payments \\| tee log |`))
  r = doctor(join(dir, 'pipe2'), plugins)
  check('doctor: a clone cell that is not owner/name (S-1) is refused in the fix with the reason, the raw cell is never printed as a command', /fix: the Clone source or Local path of payments in PROJECT\.md is refused \(the clone source is not owner\/name/.test(r.out) && !/tee log/.test(r.out) && !/fix: gh repo clone/.test(r.out), r.out)
  // App repos headers: bold, `Local path`, `Name` are still the app and its path; a table without such a column is named, not called "unfilled"
  const appHeader = (name, header, mutate = (t) => t) => {
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, name, 'PROJECT.md'), mutate(projectMd(`| billing | ${present} | gh repo clone acme/billing |`).replace(/^\| Repo \| Path \| task_path \| What it is \| Label \|$/m, header)))
    return doctor(join(dir, name), plugins)
  }
  for (const [label, header] of [['Repo | Local path', '| Repo | Local path | task_path | What it is | Label |'], ['Name | Path', '| Name | Path | task_path | What it is | Label |'], ['**Repo** | **Path**', '| **Repo** | **Path** | **task_path** | What it is | Label |']]) {
    r = appHeader(`hdr-${label.replace(/\W/g, '')}`, header)
    check(`doctor: App repos headers "${label}" are read (a filled table is not "unfilled")`, r.code === 0 && /required fields filled/.test(r.out), r.out)
  }
  r = appHeader('hdr-nopath', '| Repo | Where | task_path | What it is |')
  check('doctor: an App repos table without a Path column says so instead of "unfilled"', r.code === 1 && /App repos: the table has no Path column \(found: repo, where/.test(r.out) && !/unfilled fields: .*App repos/.test(r.out) && !/ok\s+PROJECT\.md/.test(r.out), r.out)
  r = appHeader('hdr-norepo', '| Project | Path | task_path | What it is |')
  check('doctor: an App repos table without a Repo column says so', r.code === 1 && /no Repo \(or Name\) column/.test(r.out), r.out)
  r = appHeader('hdr-comment', '| Repo | Path | task_path | What it is |', (t) => t.replace(/^\| Repo \| Path \|.*\n\|---.*\n\| dashboard \|.*$/m, '<!--\n| Repo | Path |\n|---|---|\n| ghost | /nowhere |\n-->'))
  check('doctor: an App repos table inside a comment is not read (appRepos reads visible lines only)', r.code === 1 && /unfilled fields: .*App repos/.test(r.out), r.out)
  // each App repos path must exist; with and without the Label column
  mkdirSync(join(dir, 'app-missing'))
  writeFileSync(join(dir, 'app-missing/PROJECT.md'), projectMd(`| billing | ${present} | gh repo clone acme/billing |`).replace(/^\| dashboard \|.*$/m, `| dashboard | ${join(dir, 'no-such-dashboard')} | .claude/tasks/ | web app | Dashboard |`))
  r = doctor(join(dir, 'app-missing'), plugins)
  check('doctor: an App repos path that does not exist is an error with a fix line', r.code === 1 && /ERROR\s+app repo dashboard — not found locally: .*no-such-dashboard/.test(r.out) && /fix: .*Path column of App repos/.test(r.out), r.out)
  mkdirSync(join(dir, 'app-nolabel'))
  writeFileSync(join(dir, 'app-nolabel/PROJECT.md'), projectMd(`| billing | ${present} | gh repo clone acme/billing |`).replace(/^\| dashboard \|.*$/m, `| dashboard | ${join(dir, 'dashboard')} | .claude/tasks/ | web app |`).replace(/^\| Repo \| Path \| task_path \| What it is \| Label \|$/m, '| Repo | Path | task_path | What it is |').replace(/^\|---\|---\|---\|---\|---\|$/m, '|---|---|---|---|'))
  r = doctor(join(dir, 'app-nolabel'), plugins)
  check('doctor: an App repos table without the Label column still works and finds the app path', r.code === 0 && /ok\s+app repo dashboard/.test(r.out), r.out)
  r = doctor(repo(`| billing | ${present} | gh repo clone acme/billing |`), plugins)
  check('doctor: an existing app repo path is ok', /ok\s+app repo dashboard/.test(r.out), r.out)
  // a row without a Path is an error next to a filled one; two rows with one Label are an error
  const twoApps = (name, second) => {
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, `${name}/PROJECT.md`), projectMd(`| billing | ${present} | gh repo clone acme/billing |`).replace(/^\| dashboard \|.*$/m, `| dashboard | ${join(dir, 'dashboard')} | .claude/tasks/ | web app | Dashboard |\n${second}`))
    return doctor(join(dir, name), plugins)
  }
  r = twoApps('app-nopath', '| web-admin |  | .claude/tasks/ | admin | Admin |')
  check('doctor: an App repos row with an empty Path is an error (no path in PROJECT.md)', r.code === 1 && /ERROR\s+app repo web-admin — not found locally \(no path in PROJECT\.md\)/.test(r.out), r.out)
  r = twoApps('app-duplabel', `| web-admin | ${join(dir, 'dashboard')} | .claude/tasks/ | admin | Dashboard |`)
  check('doctor: one Label on two App repos rows is an error naming both repos', r.code === 1 && /ERROR\s+app repos — the Label "Dashboard" is on more than one row.*dashboard, web-admin/.test(r.out), r.out)

  // S-1: the clone command is built by a script from checked cells, printed, and run with `gh` (no shell) only with --yes; a cell with shell syntax is refused and nothing runs
  {
    const ghbin = join(dir, 'ghbin')
    mkdirSync(ghbin)
    const trace = join(dir, 'gh-trace')
    writeFileSync(join(ghbin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${trace}'\nexit 0\n`)
    chmodSync(join(ghbin, 'gh'), 0o755)
    const cloneTo = join(dir, 'clones/payments')
    const cloneRun = (rowText, ...extra) => {
      rmSync(trace, { force: true })
      const r2 = spawnSync(process.execPath, [join(ROOT, 'scripts/clone.mjs'), repo(rowText), 'payments', ...extra], { encoding: 'utf8', env: { PATH: ghbin, HOME: dir, TMPDIR: tmpdir() } })
      return { code: r2.status, out: r2.stdout + r2.stderr }
    }
    const good = `| payments | ${cloneTo} | gh repo clone acme/payments |`
    r = cloneRun(good)
    check('clone: without --yes the exact command is printed and nothing runs', r.code === 0 && r.out.includes(`gh repo clone acme/payments '${cloneTo}' -- --depth 1`) && !existsSync(trace), r.out)
    r = cloneRun(good, '--yes')
    check('clone: with --yes gh gets the argument array, no shell', r.code === 0 && existsSync(trace) && readFileSync(trace, 'utf8') === `repo\nclone\nacme/payments\n${cloneTo}\n--\n--depth\n1\n`, r.out)
    r = cloneRun(`| payments | ${dir}/clones/x$(touch ${join(dir, 'pwned-path')}) | gh repo clone acme/payments |`, '--yes')
    check('clone: a $(...) in the path cell is refused, exit 1, nothing executed (no gh call, no file)', r.code === 1 && /refused — the path has a character/.test(r.out) && !existsSync(trace) && !existsSync(join(dir, 'pwned-path')) && !r.out.includes('$('), r.out)
    r = cloneRun(`| payments | ${cloneTo} | gh repo clone acme/payments; touch ${join(dir, 'pwned-repo')} |`, '--yes')
    check('clone: a ; in the repo cell is refused, exit 1, nothing executed', r.code === 1 && /refused — the clone source is not owner\/name/.test(r.out) && !existsSync(trace) && !existsSync(join(dir, 'pwned-repo')), r.out)
    for (const [label, cell] of [['a backtick', 'acme/pay`x`'], ['a pipe', 'acme/a|b'], ['two slashes', 'a/b/c'], ['a leading dash', '-acme/pay'], ['..', 'acme/..']]) {
      r = cloneRun(`| payments | ${cloneTo} | ${cell.replace('|', '\\|')} |`, '--yes')
      check(`clone: a clone source with ${label} is refused`, r.code === 1 && !existsSync(trace), r.out)
    }
    for (const [label, path] of [['a backtick', `${dir}/a\`x\``], ['a quote', `${dir}/a'b`], ['a newline-like ;', `${dir}/a;b`], ['&', `${dir}/a&b`], ['an absolute .. path', `${dir}/clones/../../x`], ['.. out of the parent folder', '../../elsewhere'], ['a path inside the product repo', `${dir}/acme-product/svc`]]) {
      r = cloneRun(`| payments | ${path} | gh repo clone acme/payments |`, '--yes')
      check(`clone: a path with ${label} is refused, nothing executed`, r.code === 1 && !existsSync(trace), r.out)
    }
    r = cloneRun('| payments | ../sibling-payments | acme/payments |', '--yes')
    check('clone: a relative path next to the product repo and a bare owner/name pass', r.code === 0 && readFileSync(trace, 'utf8').includes(`${join(dir, 'sibling-payments')}`), r.out)
    r = cloneRun(good, '--to', `${dir}/tmp-clone`)
    check('clone: --to is checked like the path cell', r.code === 0 && r.out.includes(`'${join(dir, 'tmp-clone')}'`), r.out)
    r = cloneRun(good, '--to', '/tmp/a$(id)')
    check('clone: --to with shell syntax is refused', r.code === 1 && !existsSync(trace), r.out)
    // M-4: the service name goes into a printed command: a plain word or nothing runs
    {
      const nameRun = (cellName, argName, ...extra) => {
        rmSync(trace, { force: true })
        const r2 = spawnSync(process.execPath, [join(ROOT, 'scripts/clone.mjs'), repo(`| ${cellName} | ${cloneTo} | gh repo clone acme/payments |`), argName, ...extra], { encoding: 'utf8', env: { PATH: ghbin, HOME: dir, TMPDIR: tmpdir() } })
        return { code: r2.status, out: r2.stdout + r2.stderr }
      }
      const pwnedName = join(dir, 'pwned-name')
      for (const [label, name] of [['$(...)', `billing$(touch ${pwnedName})`], ['a ;', 'a;b'], ['a space', 'my svc'], ['a leading -', '-x'], ['a leading .', '.hidden'], ['a backtick', 'a`id`']]) {
        r = nameRun(name.replace(/\|/g, ''), name, '--yes')
        check(`clone: a service name with ${label} is refused before anything else, nothing executed`, r.code === 1 && /refused — the service name/.test(r.out) && !existsSync(trace) && !existsSync(pwnedName), r.out)
      }
      r = nameRun('pay_ments-2.x', 'pay_ments-2.x')
      check('clone: a plain name with _ - . digits passes', r.code === 0 && r.out.includes('gh repo clone acme/payments'), r.out)
      r = doctor(repo(`| billing$(touch ${pwnedName}) | ${dir}/gone-svc | gh repo clone acme/billing |`), plugins)
      check('doctor: a service name with $(...) gets no command in the fix, only the reason', /ERROR\s+service repo with an invalid name/.test(r.out) && /fix: the service name in PROJECT\.md may hold letters/.test(r.out) && !/fix: gh repo clone/.test(r.out) && !/clone\.mjs/.test(r.out) && !existsSync(pwnedName), r.out)
      r = doctor(repo(`| my svc | ${dir}/gone-svc | gh repo clone acme/billing |`), plugins)
      check('doctor: a service name with a space gets no command either', /service repo with an invalid name/.test(r.out) && !/clone\.mjs/.test(r.out), r.out)
      r = doctor(repo(`| payments | ${join(dir, 'payments-missing')} | gh repo clone acme/payments |`), plugins)
      check('doctor: the clone.mjs line of a fix is a dry run with every argument in POSIX single quotes (the real product repo, no --yes to copy)', /\(dry run: node '[^']*clone\.mjs' '\/[^']*' 'payments' — it prints the exact command; after the user's yes to it, the same line with --yes\)/.test(r.out) && !/clone\.mjs'[^\n]*'payments' --yes/.test(r.out), r.out)
    }
    r = doctor(repo(`<!--\n## Service repos\n| Repo | Local path | Clone source |\n|---|---|---|\n| oldsvc | ${dir}/gone-old | gh repo clone acme/oldsvc |\n-->`), plugins)
    check('m-15: a Service repos table inside an HTML comment is not declared (doctor and clone.mjs read it the same way)', !/oldsvc/.test(r.out), r.out)
    // m-9: no hidden folder (~/.claude, ../.ssh), and --to only inside the system temp folder
    for (const [label, path] of [['~/.claude/skills/evil', '~/.claude/skills/evil'], ['../.ssh/x', '../.ssh/x'], ['a hidden segment in an absolute path', `${dir}/.cache/x`]]) {
      r = cloneRun(`| payments | ${path} | gh repo clone acme/payments |`, '--yes')
      check(`clone: a path cell ${label} is refused (a segment that starts with "."), nothing executed`, r.code === 1 && /starts with "\."/.test(r.out) && !existsSync(trace), r.out)
    }
    r = cloneRun(good, '--to', '/etc/evil-clone')
    check('clone: --to outside the system temp folder is refused', r.code === 1 && /system temporary folder/.test(r.out) && !existsSync(trace), r.out)
    r = cloneRun(good, '--to', `${dir}/.hidden/x`)
    check('clone: --to with a hidden segment is refused', r.code === 1 && !existsSync(trace), r.out)
    r = cloneRun(good, `--to=${dir}/eq-form`)
    check('clone: --to=<path> is accepted like --to <path>', r.code === 0 && r.out.includes(`'${join(dir, 'eq-form')}'`), r.out)
    writeFileSync(join(dir, 'a-file'), 'x')
    r = cloneRun(good, '--to', join(dir, 'a-file'))
    check('clone: --to that is a file is a clear error, not a stack trace', r.code === 1 && /--to is a file/.test(r.out) && !/at .*\.mjs|node:internal/.test(r.out) && !existsSync(trace), r.out)
    // doctor: the fix is the assembled command with the path in single quotes
    r = doctor(repo(`| payments | ${join(dir, 'payments-missing')} | gh repo clone acme/payments |`), plugins)
    check('doctor: the fix of a missing service repo is the assembled command with the path quoted, and points at clone.mjs', r.out.includes(`fix: gh repo clone acme/payments '${join(dir, 'payments-missing')}' -- --depth 1`) && /clone\.mjs/.test(r.out), r.out)
    r = doctor(repo(`| payments | ${dir}/p$(id) | gh repo clone acme/payments |`), plugins)
    check('doctor: a path cell with $(...) is refused in the fix, the fix is not a command', /fix: the Clone source or Local path of payments in PROJECT\.md is refused \(the path has a character/.test(r.out) && !/fix: gh repo clone/.test(r.out), r.out)
  }

  // S-2: PROJECT.md holds no credential: a secret-like assignment or a URI with a password is an error, the value is never printed
  {
    const withRoute = (client, tunnel) => {
      mkdirSync(join(dir, 'secret'), { recursive: true })
      writeFileSync(join(dir, 'secret/PROJECT.md'), projectMd(`| billing | ${present} | gh repo clone acme/billing |`, client).replace(/^- Tunnel command:.*$/m, `- Tunnel command: ${tunnel}`))
      return doctor(join(dir, 'secret'), plugins)
    }
    r = withRoute('psql', 'PGPASSWORD=hunter2 tunneltool --port 5432')
    check('doctor: a PGPASSWORD=value in the tunnel command is an error naming the variable, "move it out of PROJECT.md", the value hidden', r.code === 1 && /ERROR\s+PROJECT\.md — .*PROJECT\.md:\d+ holds a credential \(PGPASSWORD; the value is not shown\)/.test(r.out) && /fix: move it out of PROJECT\.md/.test(r.out) && !r.out.includes('hunter2'), r.out)
    r = withRoute('psql "postgresql://reader:s3cret@db.internal/app"', 'tunneltool --port 5432')
    check('doctor: a URI with a password in the client line is an error, the password hidden', r.code === 1 && /holds a credential \(a URI with a password/.test(r.out) && !r.out.includes('s3cret'), r.out)
    r = withRoute('psql', 'API_TOKEN=abc123 tunneltool')
    check('doctor: a TOKEN-like assignment is an error', r.code === 1 && /holds a credential \(API_TOKEN/.test(r.out) && !r.out.includes('abc123'), r.out)
    r = withRoute('psql', 'PGPASSWORD=$PGPASSWORD FOO=1 tunneltool --port 5432')
    check('doctor: a reference to the user\'s own environment ($VAR) is not a credential, and FOO=1 is still skipped when the command name is looked up', r.code === 0 && !/holds a credential/.test(r.out) && /tunneltool found on PATH/.test(r.out), r.out)
    for (const [label, client, tunnel, name, value] of [
      ['a bare password= in a quoted libpq string', 'psql "host=localhost dbname=app user=readonly_user password=hunter2"', 'tunneltool', 'password', 'hunter2'],
      ['a bare PASSWORD=', 'psql', 'PASSWORD=hunter2 tunneltool --port 5432', 'PASSWORD', 'hunter2'],
      ['a bare TOKEN=', 'psql', 'TOKEN=abc123 tunneltool', 'TOKEN', 'abc123'],
      ['"secret = x" with spaces', 'psql', 'tunneltool # secret = s3cr3t', 'secret', 's3cr3t'],
      ['--password x', 'psql', 'tunneltool --password hunter2', '--password', 'hunter2'],
      ['--password=x', 'psql', 'tunneltool --password=hunter2', 'password', 'hunter2'],
      ['API_KEY=x (KEY as a suffix segment)', 'psql', 'API_KEY=k3y-value tunneltool', 'API_KEY', 'k3y-value'],
      ['key=x (the whole name)', 'psql', 'tunneltool key=k3y-value', 'key', 'k3y-value'],
      ['PGPASSWORD in single quotes', 'psql', "PGPASSWORD='hunter2' tunneltool", 'PGPASSWORD', 'hunter2'],
    ]) {
      r = withRoute(client, tunnel)
      check(`doctor: ${label} is an error, the value hidden`, r.code === 1 && new RegExp(`holds a credential \\(${name.replace(/[-]/g, '\\$&')}`).test(r.out) && !r.out.includes(value), r.out)
    }
    for (const [label, tunnel] of [['sort_key=created_at', 'tunneltool --order sort_key=created_at'], ['an upper-case-free word with key inside (monkey=1, keyboard=us)', 'tunneltool monkey=1 keyboard=us'], ['password=$VAR / <placeholder> / empty', 'tunneltool password=$PW token=<token> secret=']]) {
      r = withRoute('psql', tunnel)
      check(`doctor: ${label} is not a credential`, r.code === 0 && !/holds a credential/.test(r.out), r.out)
    }
    // m-10: PROJECT.md that is a link to a FIFO does not hang the doctor
    {
      const fdir = join(dir, 'fifo-repo')
      mkdirSync(fdir, { recursive: true })
      const mk = spawnSync('mkfifo', [join(dir, 'a-fifo')])
      if (mk.status === 0) {
        symlinkSync(join(dir, 'a-fifo'), join(fdir, 'PROJECT.md'))
        const t0 = Date.now()
        const r2 = spawnSync(process.execPath, [join(ROOT, 'scripts/doctor.mjs'), fdir], { encoding: 'utf8', timeout: 8000, env: { PATH: bin, HOME: dir, PRODUCT_DOCTOR_PLUGINS: plugins } })
        check('doctor: a PROJECT.md that links to a FIFO is an error, not a hang (bounded read)', r2.signal === null && r2.status === 1 && /not a regular file or is larger than 4 MB/.test(r2.stdout) && Date.now() - t0 < 6000, `${r2.signal} ${r2.stdout}${r2.stderr}`)
      } else console.log('- skipped: mkfifo is not available')
    }
    r = withRoute('psql', 'tunneltool --port 5432')
    check('doctor: a route with no credential is clean', r.code === 0 && !/holds a credential/.test(r.out), r.out)
  }
  rmSync(dir, { recursive: true, force: true })
}

// product-lint, brief mode: a fixture epic built from the shipped templates, one planted defect per rule
{
  const dir = mkdtempSync(join(tmpdir(), 'product-lint-'))
  const tpl = (name) => readFileSync(join(ROOT, 'templates', name), 'utf8')
  const lint = (epic, ...extra) => run(join(ROOT, 'scripts/product-lint.mjs'), epic, ...extra)
  const D = (id, owner, rec, state) => `| ${id} | Which vendor first? | a · b | ${rec} | two days | ${owner} | ${state} |`
  const M = (base) => `| Slot swap | Swap rate | ${base} | 40% |`
  /** An epic folder: FACTS with F1, a request Q1, a STATUS, and a BRIEF built from the template with the given rows. */
  const epic = (name, { decisions, metric = M('31% (F1)'), facts = 'F1', scopeRow = '| Slot swap | — |', split = '', extra = '', brief = (b) => b } = {}) => {
    const d = join(dir, name)
    mkdirSync(join(d, 'data'), { recursive: true })
    let f = tpl('FACTS.md')
    f = fill(f, /^\| F1 \|.*$/m, '| F1 | Hosts approve most requests by hand | src/approvals.py:10 | 2026-11-01 |', 'FACTS.md')
    writeFileSync(join(d, 'FACTS.md'), f)
    writeFileSync(join(d, 'data/Q1-approvals.md'), tpl('data-request.md').replace('# Q<n>', '# Q1'))
    writeFileSync(join(d, 'STATUS.md'), tpl('STATUS.md'))
    let b = tpl('BRIEF.md')
    b = fill(b, /^- <claim> \(F<n>\)$/m, `- Hosts approve most requests by hand (${facts}).`, 'BRIEF.md')
    b = fill(b, /^\| <goal> \|.*$/m, metric, 'BRIEF.md')
    b = fill(b, /^\| D1 \|.*$/m, decisions ?? D('D1', 'the product owner', 'a', 'open'), 'BRIEF.md')
    b = fill(b, /^\| <item> \| — \|$/m, scopeRow, 'BRIEF.md')
    b = b.replace(/^## Epic and tasks\n(<!--.*-->\n)?/m, (m) => `${m}${split}`)
    writeFileSync(join(d, 'BRIEF.md'), brief(b) + extra)
    return d
  }
  // S-5: the lint reads the epic with bounds: a symlink loop, a link out of the epic, a FIFO and a 1 MB line cannot hang or crash it
  {
    const timed = (e, ...extra) => {
      const t0 = Date.now()
      const r2 = spawnSync(process.execPath, [join(ROOT, 'scripts/product-lint.mjs'), e, ...extra], { encoding: 'utf8', timeout: 20000 })
      return { code: r2.status, out: r2.stdout + r2.stderr, ms: Date.now() - t0, signal: r2.signal }
    }
    const e0 = epic('bounded')
    const base = timed(e0)
    symlinkSync('.', join(e0, 'loop'))
    symlinkSync('/', join(e0, 'root'))
    const outside = join(dir, 'outside.md')
    writeFileSync(outside, '# outside\nT1 D2 Q9\n')
    symlinkSync(outside, join(e0, 'link.md'))
    const looped = timed(e0)
    check('product-lint: a symlink loop, a link to / and a link to a file outside the epic are not followed (same result, no crash, fast)', looped.code === base.code && looped.out === base.out && looped.ms < 10000 && !/ELOOP|Error/.test(looped.out), `${base.out}\n---\n${looped.out}`)
    const e1 = epic('bounded-big', { extra: '\n' + 'a/'.repeat(500000) + '\n' + 'word '.repeat(200000) + '\n' + 'x'.repeat(1000000) + ' Q1-' + 'y'.repeat(100000) + '.md\n' })
    const big = timed(e1)
    check('product-lint: BRIEF.md lines of 1 MB (path-like, words, one long token) finish fast (the request-file pattern is linear)', big.signal === null && big.ms < 10000 && big.code !== null && !/Error|heap/.test(big.out), `${big.ms} ms ${big.signal}\n${big.out.slice(0, 300)}`)
    // m-12: an absolute or ~/ path to a request file is not an id, in the brief and in a file where Q<n> is not allowed
    {
      const pathLine = '\nSee /Users/me/acme-product/epics/x/data/Q3-usage.out:4 and ~/acme-product/epics/x/data/Q3-usage.md and data/Q3-usage.sql.\n'
      const eAbs = epic('request-abs', { extra: pathLine })
      const rAbs = timed(eAbs)
      check('product-lint: the absolute, ~/ and relative path of a request file are cut out before the ids are read (no Q3 finding)', !/Q3/.test(rAbs.out), rAbs.out)
      const eBigAbs = epic('request-abs-big', { extra: '\n/' + 'a/'.repeat(500000) + '\n~/' + 'b/'.repeat(500000) + '\n/' + 'x'.repeat(1000000) + ' ~/Q1-' + 'y'.repeat(100000) + '.md\n' })
      const bigAbs = timed(eBigAbs)
      check('product-lint: 1 MB lines that start with / or ~/ finish fast', bigAbs.signal === null && bigAbs.ms < 10000 && bigAbs.code !== null, `${bigAbs.ms} ms ${bigAbs.signal}`)
    }
    // a link out of the epic named BRIEF.md is a missing brief, not a read of the target
    const e2 = epic('bounded-link')
    rmSync(join(e2, 'BRIEF.md'))
    symlinkSync(join(e0, 'BRIEF.md'), join(e2, 'BRIEF.md'))
    const viaLink = timed(e2)
    check('product-lint: a BRIEF.md that is a symlink out of the epic is not read (brief-missing)', /brief-missing/.test(viaLink.out), viaLink.out)
    // a plain file given by --file is bounded too
    const bigDraft = join(dir, 'big-draft.md')
    writeFileSync(bigDraft, 'x'.repeat(5 * 1024 * 1024))
    const bigText = timed(e0, '--mode', 'text', '--file', bigDraft)
    check('product-lint: a --file draft over 4 MB is not read (exit 2)', bigText.code === 2 && /is not a file/.test(bigText.out), bigText.out)
    // a file over the size cap is not read
    const e3 = epic('bounded-size')
    writeFileSync(join(e3, 'BRIEF.md'), '#'.repeat(5 * 1024 * 1024))
    const huge = timed(e3)
    check('product-lint: a BRIEF.md over 4 MB is not read (brief-missing), no memory spent on it', /brief-missing/.test(huge.out) && huge.ms < 10000, huge.out.slice(0, 300))
  }
  /** The 1-based line of the first BRIEF.md line of the epic that matches `re`. */
  const lineOf = (d, re, file = 'BRIEF.md') => readFileSync(join(d, file), 'utf8').split('\n').findIndex((l) => re.test(l)) + 1
  const tasks = '\n| Id | Task |\n|---|---|\n| T1 | Show slot swap |\n'
  const hit = (out, file, line, rule) => out.split('\n').some((l) => l.startsWith(`${file}:${line} — ${rule} — `))
  const count = (out) => out.split('\n').filter((l) => / — .* — /.test(l)).length
  const mutate = (name, fn, opts) => epic(name, { ...opts, brief: fn })

  let r = lint(epic('clean'))
  check('product-lint: a clean fixture exits 0 with no findings', r.code === 0 && !/ — /.test(r.out), r.out)
  r = lint(epic('clean-split', { split: tasks, scopeRow: '| Slot swap | T1 |' }))
  check('product-lint: a v1 item with its task, after the split, is clean', r.code === 0, r.out)

  // AC-3.1: four planted defects, four findings at their exact lines
  const four = epic('four', {
    decisions: `${D('D1', '—', 'a', 'open')}\n${D('D2', 'the product owner', 'order b first', 'pending data Q1')}`,
    metric: M('—'),
    facts: 'F9',
  })
  r = lint(four)
  check('product-lint: four planted defects give four findings, exit 1', r.code === 1 && count(r.out) === 4, r.out)
  for (const [rule, re] of [['fact-undefined', /^- Hosts approve/], ['metric-no-baseline', /^\| Slot swap \| Swap rate/], ['decision-no-owner', /^\| D1 /], ['pending-data-recommendation', /^\| D2 /]]) {
    check(`product-lint: ${rule} is reported at its line`, hit(r.out, 'BRIEF.md', lineOf(four, re), rule), r.out)
  }

  // decision state: a whitelist
  for (const [label, rec, state] of [['an empty state', 'a', ''], ['"pending Q1" without "data"', 'a', 'pending Q1'], ['"decided" without date and author', 'a', 'decided'], ['"decided <date>" without the author', 'a', 'decided 2026-11-01']]) {
    const e = epic(`state-${label.length}-${state.length}`, { decisions: D('D1', 'the product owner', rec, state) })
    r = lint(e)
    check(`product-lint: ${label} is a decision-state finding`, r.code === 1 && hit(r.out, 'BRIEF.md', lineOf(e, /^\| D1 /), 'decision-state'), r.out)
  }
  {
    const e = epic('state-recommendation', { decisions: D('D1', 'the product owner', 'b first', 'waiting for data (Q1)') })
    r = lint(e)
    check('product-lint: a non-whitelisted waiting state with a recommendation gets both findings', hit(r.out, 'BRIEF.md', lineOf(e, /^\| D1 /), 'decision-state') && hit(r.out, 'BRIEF.md', lineOf(e, /^\| D1 /), 'pending-data-recommendation'), r.out)
    r = lint(epic('decided-ok', { decisions: D('D1', 'the product owner', 'a', 'decided 2026-11-03 the product owner') }))
    check('product-lint: "decided <date> <who>" is clean', r.code === 0, r.out)
  }
  // a second table in the section is read too
  {
    const e = mutate('second-decisions', (b) => b.replace(/^## Research$/m, `### Decided\n| Id | Question | Options | Recommendation | Cost | Owner | State |\n|---|---|---|---|---|---|---|\n${D('D2', '—', 'b first', 'pending data Q1')}\n\n## Research`))
    r = lint(e)
    const l = lineOf(e, /^\| D2 /)
    check('product-lint: a second decisions table is linted (owner, pending data with a recommendation)', hit(r.out, 'BRIEF.md', l, 'decision-no-owner') && hit(r.out, 'BRIEF.md', l, 'pending-data-recommendation'), r.out)
  }

  // a decisions table is found by its D<n> rows: no Owner or State column is a finding, a placeholder author does not decide
  {
    const e = mutate('plain-decisions', (b) => b.replace(/^## Research$/m, `### More\n| Id | Question | Options | Recommendation |\n|---|---|---|---|\n| D2 | Which partner first? | a · b | b first |\n\n## Research`))
    r = lint(e)
    check('product-lint: a decisions table without Owner and State columns is a finding', r.code === 1 && / — decisions-table — .*Owner column/.test(r.out) && / — decisions-table — .*State column/.test(r.out), r.out)
    for (const author of ['—', '?', 'tbd', '`<who>`']) {
      const f = epic(`author-${author.length}-${author.charCodeAt(0)}`, { decisions: D('D1', 'the product owner', 'a', `decided 2026-11-01 ${author}`) })
      r = lint(f)
      check(`product-lint: "decided <date> ${author}" is a decision-state finding`, hit(r.out, 'BRIEF.md', lineOf(f, /^\| D1 /), 'decision-state'), r.out)
    }
    const withOptions = mutate('options-table', (b) => b.replace(/^## Research$/m, `### Options\n| Option | Pros |\n|---|---|\n| a | cheap |\n\n## Research`))
    r = lint(withOptions)
    check('product-lint: a table without D<n> rows in the Decisions section is not a decisions table', r.code === 0, r.out)
    r = lint(epic('bold-id', { decisions: D('**D1**', '—', 'a', 'open') }))
    check('product-lint: a bold decision id is still read (its missing owner is found)', / — decision-no-owner — D1 /.test(r.out), r.out)
  }

  // metrics: a fact or exactly "no baseline — Q<n>"
  for (const base of ['unknown', 'not measured yet', '31%']) {
    const e = epic(`base-${base.length}`, { metric: M(base) })
    r = lint(e)
    check(`product-lint: baseline "${base}" without a fact is a finding`, r.code === 1 && hit(r.out, 'BRIEF.md', lineOf(e, /^\| Slot swap \| Swap rate/), 'metric-no-baseline'), r.out)
  }
  r = lint(epic('nb-q', { metric: M('no baseline — Q1') }))
  check('product-lint: "no baseline — Q<n>" with its request file is accepted', r.code === 0, r.out)
  r = lint(epic('nb-noq', { metric: M('no baseline') }))
  check('product-lint: "no baseline" without a Q<n> is a finding', r.code === 1 && / — metric-no-baseline — /.test(r.out), r.out)
  r = lint(epic('nb-missing', { metric: M('no baseline — Q7') }))
  check('product-lint: a Q<n> without data/Q<n>-*.md is a finding', r.code === 1 && /BRIEF\.md:\d+ — request-missing — Q7 has no file data\/Q7-<slug>\.md/.test(r.out), r.out)
  {
    const e = mutate('second-metrics', (b) => b.replace(/^## Scope$/m, `### More\n| Goal | Metric | Baseline | Target |\n|---|---|---|---|\n| Late drop-off | Check-out rate | unknown | 40% |\n\n## Scope`))
    r = lint(e)
    check('product-lint: a second metrics table is linted', hit(r.out, 'BRIEF.md', lineOf(e, /^\| Late drop-off/), 'metric-no-baseline'), r.out)
  }
  {
    // a continuation row: the second metric of the same goal leaves the Goal cell empty, the metric is named by its own column
    const e = mutate('metric-continuation', (b) => b.replace(/^## Scope$/m, `### More\n| Goal | Metric | Baseline | Target |\n|---|---|---|---|\n| Late drop-off | Check-out rate | 20% (F1) | 40% |\n|  | Late drop-off share | — | 30% |\n\n## Scope`))
    r = lint(e)
    check('product-lint: a continuation row with an empty Goal cell is still checked by its Metric', hit(r.out, 'BRIEF.md', lineOf(e, /^\|  \| Late drop-off share/), 'metric-no-baseline'), r.out)
  }
  r = lint(epic('pending-ok', { decisions: D('D1', 'the product owner', '—', 'pending data Q1') }))
  check('product-lint: pending data with recommendation "—" is clean', r.code === 0, r.out)

  // scope
  {
    const e = epic('scope-notask', { split: tasks, scopeRow: '| Slot swap | — |' })
    r = lint(e)
    check('product-lint: a v1 item without a task once the split is filled is a finding', r.code === 1 && hit(r.out, 'BRIEF.md', lineOf(e, /^\| Slot swap \| —/), 'scope-no-task'), r.out)
  }
  r = lint(epic('scope-badtask', { split: tasks, scopeRow: '| Slot swap | T4 |' }))
  check('product-lint: a v1 item naming a task that the split does not have is a finding', r.code === 1 && /scope-no-task — .*T4/.test(r.out), r.out)
  {
    const e = mutate('scope-second', (b) => b.replace(/^### Later$/m, '| Item | Task |\n|---|---|\n| Late drop-off | — |\n\n### Later'), { split: tasks, scopeRow: '| Slot swap | T1 |' })
    r = lint(e)
    check('product-lint: a second scope table is linted', hit(r.out, 'BRIEF.md', lineOf(e, /^\| Late drop-off/), 'scope-no-task'), r.out)
  }

  // scope: a Scope section whose table has a v1 column (a hand-made brief's v1 / Later / Out matrix) is a scope; neither form is named exactly
  {
    const matrix = '## Scope\n| | v1 | Later | Out |\n|---|---|---|---|\n| partners | five | the rest | — |\n'
    let e = mutate('scope-matrix', (b) => b.replace(/^## Scope$/m, matrix).replace(/^### v1$/m, '### Items'))
    r = lint(e)
    check('product-lint: a Scope table with a v1 column is the v1 scope', r.code === 0, r.out)
    e = mutate('scope-matrix-numbered', (b) => b.replace(/^## Scope$/m, matrix.replace('## Scope', '## 6. Scope')).replace(/^### v1$/m, '### Items'), { split: tasks, scopeRow: '| Slot swap | T1 |' })
    r = lint(e)
    check('product-lint: a v1-column matrix under a numbered Scope heading is read, and needs no Task column', r.code === 0, r.out)
    // a matrix that has a Task column is checked like the v1 table: an item in its v1 column names a task of the split
    const taskMatrix = (rows) => matrix.replace('| | v1 | Later | Out |\n|---|---|---|---|', '| | v1 | Later | Out | Task |\n|---|---|---|---|---|').replace(/^\| partners .*$/m, rows)
    e = mutate('scope-matrix-task-ok', (b) => b.replace(/^## Scope$/m, taskMatrix('| partners | five | the rest | — | T1 |')).replace(/^### v1$/m, '### Items'), { split: tasks })
    check('product-lint: a v1 matrix with a Task column naming a task of the split is clean', lint(e).code === 0, lint(e).out)
    e = mutate('scope-matrix-task-empty', (b) => b.replace(/^## Scope$/m, taskMatrix('| partners | five | the rest | — | — |')).replace(/^### v1$/m, '### Items'), { split: tasks })
    r = lint(e)
    check('product-lint: a v1 matrix item without a task is scope-no-task once the split is filled', r.code === 1 && hit(r.out, 'BRIEF.md', lineOf(e, /^\| partners/), 'scope-no-task'), r.out)
    e = mutate('scope-matrix-task-bad', (b) => b.replace(/^## Scope$/m, taskMatrix('| partners | five | the rest | — | T9 |')).replace(/^### v1$/m, '### Items'), { split: tasks })
    r = lint(e)
    check('product-lint: a v1 matrix item naming a task the split does not have is scope-no-task', r.code === 1 && /scope-no-task — .*T9/.test(r.out), r.out)
    e = mutate('scope-matrix-task-later', (b) => b.replace(/^## Scope$/m, taskMatrix('| partners | — | the rest | — | — |')).replace(/^### v1$/m, '### Items'), { split: tasks })
    check('product-lint: an item that is not in the matrix v1 column needs no task', lint(e).code === 0, lint(e).out)
    e = mutate('scope-none', (b) => b.replace(/^### v1$/m, '### Items'))
    r = lint(e)
    check('product-lint: no v1 column and no v1 subsection says exactly that', r.code === 1 && hit(r.out, 'BRIEF.md', lineOf(e, /^## Scope$/), 'section-missing') && /no v1 column or v1 subsection under Scope/.test(r.out), r.out)
    e = mutate('scope-gone', (b) => b.replace(/^## Scope$/m, '## Extent').replace(/^### v1$/m, '### Items'))
    r = lint(e)
    check('product-lint: no Scope section at all gives the same message', r.code === 1 && /no v1 column or v1 subsection under Scope/.test(r.out), r.out)
  }

  // structure: one fixture per rule
  {
    let e = mutate('no-decisions-section', (b) => b.replace(/^## Decisions$/m, '## Choices'))
    r = lint(e)
    check('product-lint: section-missing when the Decisions heading is gone', hit(r.out, 'BRIEF.md', 1, 'section-missing') && /no "Decisions" section/.test(r.out), r.out)
    e = mutate('no-decisions-table', (b) => b.replace(/^\| (Id \| Question|---\|---\|---\|---\|---\|---\|---|D1 ).*$/gm, ''))
    r = lint(e)
    check('product-lint: decisions-table when the Decisions section has no table', hit(r.out, 'BRIEF.md', lineOf(e, /^## Decisions$/), 'decisions-table'), r.out)
    e = mutate('no-metrics-table', (b) => b.replace(/^\| (Goal \||---\|---\|---\|---\||<goal>|Slot swap \| Swap).*$/gm, ''))
    r = lint(e)
    check('product-lint: metrics-table when the metrics section has no Baseline table', hit(r.out, 'BRIEF.md', lineOf(e, /^## Goals and metrics$/), 'metrics-table'), r.out)
    e = mutate('no-scope-table', (b) => b.replace(/^\| (Item \| Task|---\|---|Slot swap).*$/gm, ''))
    r = lint(e)
    check('product-lint: scope-table when v1 has no table', hit(r.out, 'BRIEF.md', lineOf(e, /^### v1$/), 'scope-table'), r.out)
    e = mutate('no-state-column', (b) => b.replace(/ \| State \|$/m, ' |').replace(/^\|---\|---\|---\|---\|---\|---\|---\|$/m, '|---|---|---|---|---|---|').replace(/ \| open \|$/m, ' |'))
    r = lint(e)
    check('product-lint: decisions-table names the missing State column at the header line', hit(r.out, 'BRIEF.md', lineOf(e, /^\| Id \| Question/), 'decisions-table') && /no State column/.test(r.out), r.out)
    e = mutate('no-task-column', (b) => b.replace(/^\| Item \| Task \|$/m, '| Item | Owner |'), { split: tasks, scopeRow: '| Slot swap | T1 |' })
    r = lint(e)
    check('product-lint: scope-table names the missing Task column at the header line', hit(r.out, 'BRIEF.md', lineOf(e, /^\| Item \| Owner/), 'scope-table'), r.out)
  }

  // references outside BRIEF.md, comments and fences
  {
    const e = epic('status-q')
    writeFileSync(join(e, 'STATUS.md'), `${readFileSync(join(e, 'STATUS.md'), 'utf8')}\nWaiting for Q7\n`)
    writeFileSync(join(e, 'FACTS.md'), `${readFileSync(join(e, 'FACTS.md'), 'utf8')}\nSee Q8\n`)
    r = lint(e)
    check('product-lint: a Q<n> without a request file in STATUS.md and in FACTS.md is a finding', hit(r.out, 'STATUS.md', lineOf(e, /Waiting for Q7/, 'STATUS.md'), 'request-missing') && hit(r.out, 'FACTS.md', lineOf(e, /See Q8/, 'FACTS.md'), 'request-missing'), r.out)
    r = lint(epic('comment-ids', { extra: '\n<!-- F9 Q9 D9 -->\n\n```\nF8 Q8\n```\n' }))
    check('product-lint: ids inside an HTML comment or a code fence are not read', r.code === 0, r.out)
    r = lint(epic('quarters', { extra: '\nDesign in Q1 2027, build in Q3 2027.\n' }))
    check('product-lint: "Q1 2027" is a quarter, not a data request', r.code === 0, r.out)
    r = lint(mutate('numbered', (b) => b.replace(/^## Decisions$/m, '## 8. Decisions needed').replace(/^## Goals and metrics$/m, '## 5. Goals and success metrics').replace(/^### v1$/m, '### 6. v1')))
    check('product-lint: numbered and reworded headings are recognised', r.code === 0, r.out)
    const ru = mutate('russian-prose', (b) => b.replace(/^- Hosts approve.*$/m, `- ${CYR} (F1).`).replace(/^## Summary$/m, `## Summary\n${CYR} ${CYR}.`))
    r = lint(ru)
    check('product-lint: Russian prose under the English skeleton lints clean', r.code === 0, r.out)
    const e2 = epic('check-ids')
    mkdirSync(join(e2, 'checks'))
    writeFileSync(join(e2, 'checks/brief-review-1.md'), '# Review\n- D1 is `pending data Q1` and recommends b first (F1)\n')
    r = lint(e2)
    check('product-lint: a review report in checks/ may quote F, D and Q ids', r.code === 0, r.out)
  }

  // id placement, read from the contract
  const bad = epic('ids')
  mkdirSync(join(bad, 'messages'))
  writeFileSync(join(bad, 'messages/to-owner.md'), 'Hello,\n\nWe need D1 answered (see data/Q1-approvals.md) and T2 is blocked.\n')
  mkdirSync(join(bad, 'adopted'))
  writeFileSync(join(bad, 'adopted/old-brief.md'), 'D1 F1 T1 as it was\n')
  r = lint(bad)
  check('product-lint: an epic id in messages/ is a finding; a data file name and adopted/ are not', r.code === 1 && /messages\/to-owner\.md:3 — id-not-allowed — D1 may not appear/.test(r.out) && /T2 may not appear/.test(r.out) && !/Q1 may not/.test(r.out) && !/adopted/.test(r.out), r.out)
  r = lint(epic('ids-ok', { extra: '' }))
  check('product-lint: ids in BRIEF.md, FACTS.md, STATUS.md and data/ are allowed', r.code === 0, r.out)
  {
    // the rule comes from the contract table: change the column and the lint follows; break it and the lint refuses to run
    const copyDir = copy()
    const contract = join(copyDir, 'references/product-repo.md')
    writeFileSync(contract, readFileSync(contract, 'utf8').replace(/^(\| `D<n>` [^\n]*?\| )STATUS\.md, /m, '$1'))
    const e = epic('ids-contract', { extra: '' })
    writeFileSync(join(e, 'STATUS.md'), `${readFileSync(join(e, 'STATUS.md'), 'utf8')}\nOpen: D1\n`)
    const got = run(join(copyDir, 'scripts/product-lint.mjs'), e)
    check('product-lint: the placement rule is read from references/product-repo.md at run time', got.code === 1 && /STATUS\.md:\d+ — id-not-allowed — D1/.test(got.out), got.out)
    writeFileSync(contract, readFileSync(contract, 'utf8').replace(/May appear in/g, 'Elsewhere'))
    const broken = run(join(copyDir, 'scripts/product-lint.mjs'), e)
    check('product-lint: an unreadable id table stops the lint with exit 2', broken.code === 2 && /cannot read the id table/.test(broken.out), broken.out)
    rmSync(copyDir, { recursive: true, force: true })
  }

  // the unfilled template, --json, usage
  const blank = join(dir, 'blank')
  mkdirSync(blank)
  cpSync(join(ROOT, 'templates/BRIEF.md'), join(blank, 'BRIEF.md'))
  r = lint(blank)
  check('product-lint: the unfilled BRIEF template fails the lint', r.code === 1 && / — decision-no-owner — /.test(r.out) && / — metric-no-baseline — /.test(r.out), r.out)
  r = lint(four, '--json')
  let parsed = null
  try {
    parsed = JSON.parse(r.out.slice(0, r.out.lastIndexOf('}') + 1))
  } catch {
    // reported below
  }
  check('product-lint: --json carries mode, count and findings with file, line, rule, message', parsed && parsed.mode === 'brief' && parsed.count === 4 && parsed.findings.every((f) => f.file && f.line && f.rule && f.message), r.out)
  r = lint(join(dir, 'missing-dir'))
  check('product-lint: a missing epic dir exits 2', r.code === 2, r.out)
  r = lint(join(dir, 'clean'), '--mode', 'nope')
  check('product-lint: an unknown mode exits 2 and names the modes', r.code === 2 && /modes: brief/.test(r.out), r.out)
  mkdirSync(join(dir, 'nobrief'))
  r = lint(join(dir, 'nobrief'))
  check('product-lint: an epic without BRIEF.md is a finding', r.code === 1 && /BRIEF\.md:1 — brief-missing — /.test(r.out), r.out)
  rmSync(dir, { recursive: true, force: true })
}

// product-lint, jira mode: JIRA.md built from the shipped template, one planted defect per rule
{
  const root = mkdtempSync(join(tmpdir(), 'product-jira-'))
  const tpl = readFileSync(join(ROOT, 'templates/JIRA.md'), 'utf8')
  const project = fill(readFileSync(join(ROOT, 'templates/PROJECT.md'), 'utf8'), /^\| <dashboard> \|.*$/m, '| Dashboard | ~/dashboard | .claude/tasks/ | web app |\n| Guest app | ~/guest | .claude/tasks/ | guest web app |', 'PROJECT.md')
  writeFileSync(join(root, 'PROJECT.md'), project)
  const lint = (epic, ...extra) => run(join(ROOT, 'scripts/product-lint.mjs'), epic, '--mode', 'jira', ...extra)
  const hit = (out, line, rule) => out.split('\n').some((l) => l.startsWith(`JIRA.md:${line} — ${rule} — `))
  const count = (out) => out.split('\n').filter((l) => / — .* — /.test(l)).length
  const CRIT = '- WHEN <condition> THEN <observable result>'
  const FILLED = 'Written out.'
  /** A filled JIRA.md written to epics/<name>/; `edit` changes the filled text before it is written. */
  const jira = (name, edit = (t) => t, { withProject = true } = {}) => {
    const base = withProject ? root : mkdtempSync(join(tmpdir(), 'product-jira-np-'))
    const d = join(base, 'epics', name)
    mkdirSync(d, { recursive: true })
    let t = tpl
    t = fill(t, /^- \*\*<question>:\*\*.*$/m, '- **Which vendor first:** the larger one → Dana, the product owner', 'JIRA.md')
    // the summary is written twice, in the key map and in the heading: both are filled the same way
    t = fill(t, /^\| E \| — \| Epic \| <summary> \|/m, '| E | — | Epic | Slot swap |', 'JIRA.md').replace('### Epic: <summary>', '### Epic: Slot swap')
    t = fill(t, /^\| T1 \| — \| Story \| <summary> \|/m, '| T1 | — | Story | Offer availability |', 'JIRA.md').replace('### Story: <summary>', '### Story: Offer availability')
    t = t.replaceAll('[FE <app>] <summary>', '[FE Dashboard] Show availability on offers').replaceAll('[BE] <summary>', '[BE] Availability check for the vendor')
    t = fill(t, /^2\. <the implementation>$/m, '2. The availability check behind the contract.', 'JIRA.md')
    t = t.replaceAll(CRIT, '- WHEN a guest asks for slot swap THEN the offer shows only when a room is free')
    // every other placeholder of the ticket texts is filled (the header and the key map keep theirs: the lint does not read them for placeholders)
    const at = t.indexOf('\n## Tickets')
    t = t.slice(0, at) + t.slice(at).replace(/<(?!!--)[^<>\n]+>/g, FILLED)
    writeFileSync(join(d, 'JIRA.md'), edit(t))
    return d
  }
  /** A ticket added to the key map and the end of the text: map row after T1.2, heading and body at the end. */
  const addTicket = (id, heading, body, summary) => (t) =>
    `${t.replace(/^(\| T1\.2 \|.*)$/m, `$1\n| ${id} | — | Sub-task | ${summary} | T1 | — | — | 9 |`)}\n${heading} <!-- ${id} -->\n\n${body}\n`
  const lineOf = (d, re) => readFileSync(join(d, 'JIRA.md'), 'utf8').split('\n').findIndex((l) => re.test(l)) + 1
  /** Text of one ticket with a line added after its heading's first blank line. */
  const addAfter = (re, extra) => (t) => t.replace(re, (m) => `${m}\n${extra}`)
  const addToText = (extra) => addAfter(/^\*\*Why\*\*$/m, extra)

  let r = lint(jira('clean'))
  check('product-lint jira: a fixture built from the template is clean', r.code === 0 && !/ — /.test(r.out), r.out)
  r = lint(jira('map-exempt', (t) => t.replace(/^\| T1 \| — \| Story \|.*$/m, '| T1 | — | Story | Offer availability | E | — | D14, D15 (T0, F1, Q1, P2, §9, brief) | 2 |')))
  check('product-lint jira: epic ids, §, and "brief" inside the key map are not findings', r.code === 0, r.out)
  r = lint(jira('quarter', addToText('Venues will see it in Q1 2027.')))
  check('product-lint jira: a quarter is a date, not an epic id', r.code === 0, r.out)
  for (const path of ['data/Q3-vendors.md', 'research/partner-matrix.md', 'checks/pro-review-1.md', 'messages/2026-11-02-owner.md', 'adopted/INTAKE.md', 'BRIEF.md', 'FACTS.md']) {
    const x = jira(`path-${path.replace(/\W/g, '-')}`, addToText(`The numbers are in ${path} of the product repo.`))
    check(`product-lint jira: a path into the epic (${path}) in a ticket text is a finding`, hit(lint(x).out, lineOf(x, /^The numbers are in/), 'ticket-epic-file'), lint(x).out)
  }
  r = lint(jira('url-path', addToText('Docs at https://example.com/data/export.html and in metadata/notes.')))
  check('product-lint jira: a URL or a longer word that ends in data/ is not a path into the epic', r.code === 0, r.out)

  // AC-4.1: D<n> and § in a text, [FE] without an app, [BE] without the contract: one finding each, at its line
  const four = jira('four', (t) => {
    t = t.replace(/^\*\*Why\*\*$/m, '**Why**\nSee D14 for the vendor choice.\nThe rules are in §9.')
    t = t.replaceAll('[FE Dashboard] Show availability on offers', '[FE] Show availability on offers')
    return t.replace(/^1\. The API contract.*$/m, '1. The availability check first.')
  })
  r = lint(four)
  check('product-lint jira: four planted defects give four findings, exit 1', r.code === 1 && count(r.out) === 4, r.out)
  for (const [rule, re] of [['ticket-epic-id', /^See D14/], ['ticket-section-ref', /^The rules are in §9/], ['fe-no-app', /^### Sub-task: \[FE\]/]]) {
    check(`product-lint jira: ${rule} is reported at its line`, hit(r.out, lineOf(four, re), rule), r.out)
  }
  check('product-lint jira: be-no-contract is reported at the first deliverable', hit(r.out, lineOf(four, /^1\. The availability check first/), 'be-no-contract'), r.out)

  // each id and word is its own finding at its line
  for (const [label, text] of [['T<n>', 'Builds on T3.'], ['F<n>', 'The fact F2 says so.'], ['Q<n>', 'Waiting for Q4.'], ['P<n>', 'Solves P1.'], ['D<n>', 'Waits for D7.']]) {
    const e = jira(`id-${label[0]}`, addToText(text))
    r = lint(e)
    check(`product-lint jira: ${label} in a text is a finding`, r.code === 1 && hit(r.out, lineOf(e, new RegExp(`^${text}$`)), 'ticket-epic-id') && count(r.out) === 1, r.out)
  }
  let e = jira('brief-word', addToText('As in the brief.'))
  r = lint(e)
  check('product-lint jira: the word "brief" is a finding', r.code === 1 && hit(r.out, lineOf(e, /^As in the brief/), 'ticket-brief-ref'), r.out)
  e = jira('brief-sub', addToText('A briefing and a debrief are fine.'))
  check('product-lint jira: "briefing" is not the word "brief"', lint(e).code === 0)
  e = jira('two-ids', addToText('Both D1 and D2 apply, and D1 twice more: D1.'))
  r = lint(e)
  check('product-lint jira: two distinct ids on a line are two findings, a repeat is one', count(r.out) === 2, r.out)
  e = jira('other-table', addToText('| Id | Note |\n|---|---|\n| T1 | row in another table |'))
  r = lint(e)
  check('product-lint jira: an id in a table other than the key map is a finding', hit(r.out, lineOf(e, /^\| T1 \| row in another table/), 'ticket-epic-id'), r.out)
  e = jira('header', (t) => t.replace(/^Status:.*$/m, 'Status: see D3 in the brief'))
  r = lint(e)
  check('product-lint jira: the header notes above the key map are local: an id and "brief" there are no findings', r.code === 0 && !/ticket-epic-id|ticket-brief-ref/.test(r.out), r.out)
  e = jira('header-text', (t) => t.replace(/^Status:.*$/m, 'Status: see D3 in the brief').replace(/^\*\*Why\*\*$/m, '**Why**\nSee D3 for the vendor choice.'))
  r = lint(e)
  check('product-lint jira: a ticket text still gets the id rule when the header has notes', r.code === 1 && count(r.out) === 1 && hit(r.out, lineOf(e, /^See D3 for the vendor/), 'ticket-epic-id'), r.out)

  // a hand-made draft: "(not created)" before the heading's words is no part of the summary; the no-id message names the key-prefix form
  e = jira('not-created', (t) => t.replace('### Sub-task: [BE] Availability check for the vendor', '### (not created) Sub-task: [BE] Availability check for the vendor'))
  r = lint(e)
  check('product-lint jira: a leading "(not created)" on a heading is ignored in the summary comparison', r.code === 0 && !/map-summary/.test(r.out), r.out)
  e = jira('not-created-2', (t) => t.replace('### Sub-task: [BE] Availability check for the vendor', '### (not created) [BE] Availability check for the vendor'))
  r = lint(e)
  check('product-lint jira: "(not created)" before a bare [BE] tag (no type word) is ignored too', r.code === 0 && !/map-summary/.test(r.out), r.out)
  e = jira('no-id-msg', (t) => t.replace(/^(### Sub-task: \[BE\] Availability check for the vendor) <!-- T1\.1 -->$/m, '$1'))
  r = lint(e)
  check('product-lint jira: ticket-no-id mentions the id comment and the key-prefix form', hit(r.out, lineOf(e, /^### Sub-task: \[BE\] Availability check/), 'ticket-no-id') && /<!-- T1\.1 -->/.test(r.out) && /Jira key at the start/.test(r.out), r.out)

  // the Label column of App repos: what [FE <app>] names, matched before the repo name
  {
    const lroot = mkdtempSync(join(tmpdir(), 'product-jira-label-'))
    const withRows = (...rows) => fill(readFileSync(join(ROOT, 'templates/PROJECT.md'), 'utf8'), /^\| <dashboard> \|.*$/m, rows.join('\n'), 'PROJECT.md')
    mkdirSync(join(lroot, 'epics/x'), { recursive: true })
    writeFileSync(join(lroot, 'epics/x/JIRA.md'), readFileSync(join(jira('label-src'), 'JIRA.md'), 'utf8'))
    const at = (...rows) => {
      writeFileSync(join(lroot, 'PROJECT.md'), withRows(...rows))
      return lint(join(lroot, 'epics/x'))
    }
    r = at('| web-dashboard | ~/dc | .claude/tasks/ | web app | Dashboard |')
    check('product-lint jira: [FE Dashboard] matches the app repo web-dashboard by its Label', r.code === 0 && !/fe-unknown-app/.test(r.out), r.out)
    r = at('| web-dashboard | ~/dc | .claude/tasks/ | web app |')
    check('product-lint jira: without a Label the repo name is the name, and the error names Label and --repo', r.code === 1 && / — fe-unknown-app — /.test(r.out) && /Label/.test(r.out) && /--repo/.test(r.out) && /web-dashboard/.test(r.out), r.out)
    r = at('| web-dashboard | ~/dc | .claude/tasks/ | web app | Web |')
    check('product-lint jira: a Label that is not the ticket\'s app does not match (and the message lists it)', r.code === 1 && /fe-unknown-app — .*Web/.test(r.out), r.out)
    // a Label beats a repo name that is the same word, in either row order
    const plain = '| dashboard | ~/d1 | .claude/tasks/ | old app |'
    const labelled = '| web-dashboard | ~/d2 | .claude/tasks/ | web app | Dashboard |'
    for (const rows of [[plain, labelled], [labelled, plain]]) {
      r = at(...rows)
      check(`product-lint jira: [FE Dashboard] with a Label row and a repo-name row is one app (${rows[0] === plain ? 'repo row first' : 'Label row first'})`, r.code === 0 && !/fe-ambiguous-app|fe-unknown-app/.test(r.out), r.out)
    }
    // two rows with one Label: the ticket names two apps, and PROJECT.md is a finding of its own
    r = at('| web-dashboard | ~/d2 | .claude/tasks/ | web app | Dashboard |', '| web-admin | ~/d3 | .claude/tasks/ | admin | Dashboard |')
    check('product-lint jira: one Label on two rows is fe-ambiguous-app naming both, and app-name-duplicate', r.code === 1 && / — fe-ambiguous-app — .*web-dashboard, web-admin/.test(r.out) && / — app-name-duplicate — .*Dashboard.*web-dashboard, web-admin/.test(r.out), r.out)
    // a repo name that is another row's Label: the Label tier wins even when its row is second
    r = at('| dashboard | ~/d1 | .claude/tasks/ | old app | Web |', '| web-dashboard | ~/d2 | .claude/tasks/ | web app | Dashboard |')
    check('product-lint jira: a repo name equal to the ticket\'s app does not shadow the Label row', r.code === 0, r.out)
    rmSync(lroot, { recursive: true, force: true })
  }

  // a ticket above the key map is read: the header skip stops at the first ticket
  e = jira('ticket-above-map', (t) => t.replace(/^## Key map/m, '### Early epic <!-- E -->\n\nSee D14 and §9 of the brief.\n\n## Key map'))
  r = lint(e)
  check('product-lint jira: a ticket above the key map is not header notes: its id, section reference and "brief" are findings', r.code === 1 && hit(r.out, lineOf(e, /^See D14/), 'ticket-epic-id') && hit(r.out, lineOf(e, /^See D14/), 'ticket-section-ref') && hit(r.out, lineOf(e, /^See D14/), 'ticket-brief-ref'), r.out)

  // apps from PROJECT.md
  for (const app of ['Dashboard', 'dashboard', 'Guest app', 'guest-app']) {
    e = jira(`app-${app}`, (t) => t.replaceAll('[FE Dashboard]', `[FE ${app}]`))
    check(`product-lint jira: [FE ${app}] matches an app of PROJECT.md`, lint(e).code === 0, lint(e).out)
  }
  e = jira('app-unknown', (t) => t.replaceAll('[FE Dashboard]', '[FE Mobile]'))
  r = lint(e)
  check('product-lint jira: [FE Mobile] is not an app of PROJECT.md', r.code === 1 && hit(r.out, lineOf(e, /^### Sub-task: \[FE Mobile\]/), 'fe-unknown-app') && /Dashboard/.test(r.out), r.out)
  e = jira('app-noproject', (t) => t, { withProject: false })
  r = lint(e)
  check('product-lint jira: without a PROJECT.md an [FE <app>] cannot be matched', r.code === 1 && / — fe-unknown-app — .*no PROJECT\.md/.test(r.out), r.out)
  e = jira('fe-empty-brackets', (t) => t.replaceAll('[FE Dashboard]', '[FE ]'))
  check('product-lint jira: "[FE ]" is fe-no-app', hit(lint(e).out, lineOf(e, /^### Sub-task: \[FE \]/), 'fe-no-app'))

  // criteria
  e = jira('no-criteria-fe', (t) => t.replace(/(### (?:Task|Sub-task): \[FE Dashboard\][\s\S]*?)^- WHEN.*\n/m, '$1'))
  r = lint(e)
  check('product-lint jira: a subtask without a WHEN/THEN criterion is a finding at its heading', r.code === 1 && hit(r.out, lineOf(e, /^### Sub-task: \[FE Dashboard\]/), 'subtask-no-criteria') && count(r.out) === 1, r.out)
  e = jira('when-only', (t) => t.replace(/(### (?:Task|Sub-task): \[FE Dashboard\][\s\S]*?)^- WHEN.*$/m, '$1- WHEN a guest asks for it the offer shows'))
  check('product-lint jira: a WHEN without THEN is not a criterion', hit(lint(e).out, lineOf(e, /^### Sub-task: \[FE Dashboard\]/), 'subtask-no-criteria'))
  e = jira('design', addTicket('T1.3', '### [Design] Mockups for the offer', '**What**\nMockups.', '[Design] Mockups for the offer'))
  check('product-lint jira: a [Design] subtask (no "Sub-task:" prefix) without criteria is a finding', hit(lint(e).out, lineOf(e, /^### \[Design\]/), 'subtask-no-criteria'))
  e = jira('plain-subtask', addTicket('T1.3', '### Sub-task: Mockups for the offer', '**What**\nMockups.', 'Mockups for the offer'))
  check('product-lint jira: a "Sub-task:" heading without a tag still needs criteria', hit(lint(e).out, lineOf(e, /^### Sub-task: Mockups/), 'subtask-no-criteria'))
  e = jira('lower-criteria', (t) => t.replace(/(### (?:Task|Sub-task): \[FE Dashboard\][\s\S]*?)^- WHEN.*$/m, '$1- when a guest asks then the offer shows'))
  check('product-lint jira: a lower-case "when ... then" is not the WHEN/THEN form', hit(lint(e).out, lineOf(e, /^### Sub-task: \[FE Dashboard\]/), 'subtask-no-criteria'))
  e = jira('design-ok', addTicket('T1.3', '### Sub-task: [Design] Mockups for the offer', '- WHEN the designer hands over THEN every state of the offer has a screen', '[Design] Mockups for the offer'))
  check('product-lint jira: a [Design] subtask with a criterion is clean', lint(e).code === 0, lint(e).out)
  e = jira('story-no-criteria')
  check('product-lint jira: a story (not a subtask) needs no criteria', lint(e).code === 0)

  // [BE] contract first
  e = jira('be-second', (t) => t.replace(/^1\. The API contract.*\n2\. .*$/m, '1. The implementation.\n2. The API contract, reviewed by the frontend.'))
  r = lint(e)
  check('product-lint jira: a contract that is not the first deliverable is a finding at the first item', r.code === 1 && hit(r.out, lineOf(e, /^1\. The implementation\./), 'be-no-contract'), r.out)
  e = jira('be-nolist', (t) => t.replace(/^\*\*Deliverables\*\*\n1\..*\n2\..*\n\n/m, ''))
  r = lint(e)
  check('product-lint jira: a [BE] subtask without a Deliverables list is a finding at its heading', r.code === 1 && hit(r.out, lineOf(e, /^### Sub-task: \[BE\]/), 'be-no-contract'), r.out)
  e = jira('fe-deliverables', (t) => t.replace(/(### (?:Task|Sub-task): \[FE Dashboard\][\s\S]*?\*\*Criteria\*\*)/, '$1\n- WHEN a guest asks THEN the offer shows\n\n**Deliverables**\n1. The screen.\n\n**Criteria**'))
  check('product-lint jira: only [BE] subtasks must start with the contract', lint(e).code === 0, lint(e).out)

  // the epic
  e = jira('epic-nolist', (t) => t.replace(/^- \*\*Which vendor first:\*\*.*$/m, ''))
  r = lint(e)
  check('product-lint jira: an epic whose Open decisions has no list is a finding at the label', r.code === 1 && hit(r.out, lineOf(e, /^\*\*Open decisions\*\*/), 'epic-no-open-decisions'), r.out)
  e = jira('epic-nolabel', (t) => t.replace(/^\*\*Open decisions\*\*.*\n- .*$/m, ''))
  r = lint(e)
  check('product-lint jira: an epic without Open decisions at all is a finding at its heading', r.code === 1 && hit(r.out, lineOf(e, /^### Epic:/), 'epic-no-open-decisions'), r.out)
  e = jira('epic-list-elsewhere', (t) => t.replace(/^- \*\*Which vendor first:\*\*.*$/m, '**Success:** other\n- an item of another list'))
  check('product-lint jira: a list after the next label is not the open decisions list', hit(lint(e).out, lineOf(e, /^\*\*Open decisions\*\*/), 'epic-no-open-decisions'))
  e = jira('epic-none', (t) => t.replace(/^- \*\*Which vendor first:\*\*.*$/m, '- None: every decision is made.'))
  check('product-lint jira: "None" as the one item is accepted', lint(e).code === 0, lint(e).out)
  e = jira('epic-missing', (t) => t.replace(/^### Epic: .*$/m, '### Overview: <summary>'))
  r = lint(e)
  check('product-lint jira: a JIRA.md without an epic section is a finding', hit(r.out, 1, 'epic-missing'), r.out)
  e = join(root, 'epics', 'no-jira')
  mkdirSync(e, { recursive: true })
  r = lint(e)
  check('product-lint jira: an epic without JIRA.md is a finding', r.code === 1 && hit(r.out, 1, 'jira-missing'), r.out)
  r = lint(jira('json'), '--json')
  check('product-lint jira: --json reports mode jira', r.code === 0 && /"mode": "jira"/.test(r.out), r.out)

  // M-1: the tag stands anywhere in the heading, after an optional type word
  for (const [label, heading] of [['Task: [FE] ...', '### Task: [FE] Show availability on offers'], ['Sub-task — [FE] ...', '### Sub-task — [FE] Show availability on offers'], ['Sub-task [FE] ...', '### Sub-task [FE] Show availability on offers'], ['[FE] ... alone', '### [FE] Show availability on offers']]) {
    e = jira(`form-${label.replace(/\W/g, '')}`, (t) => t.replaceAll('[FE Dashboard] Show availability on offers', '[FE] Show availability on offers').replace(/^### Sub-task: \[FE\] Show availability on offers/m, heading))
    check(`product-lint jira: "${label}" is read as a subtask (an [FE] without an app is fe-no-app)`, hit(lint(e).out, lineOf(e, /^### .*\[FE\] Show/), 'fe-no-app'), lint(e).out)
  }
  e = jira('task-be', (t) => t.replace(/^### Sub-task: \[BE\]/m, '### Task: [BE]').replace(/^1\. The API contract.*$/m, '1. The availability check first.'))
  check('product-lint jira: "Task: [BE] ..." without the contract is be-no-contract', hit(lint(e).out, lineOf(e, /^1\. The availability check first/), 'be-no-contract'), lint(e).out)
  e = jira('task-nocrit', (t) => t.replace(/^### Sub-task: \[FE Dashboard\]/m, '### Task: [FE Dashboard]').replace(/(### (?:Task|Sub-task): \[FE Dashboard\][\s\S]*?)^- WHEN.*\n/m, '$1'))
  check('product-lint jira: "Task: [FE app] ..." without criteria is subtask-no-criteria', hit(lint(e).out, lineOf(e, /^### Task: \[FE Dashboard\]/), 'subtask-no-criteria'), lint(e).out)
  e = jira('task-plain', addTicket('T1.3', '### Task: Update the help center', '**What**\nText.', 'Update the help center'))
  check('product-lint jira: a plain "Task:" without a tag needs no criteria', lint(e).code === 0, lint(e).out)

  // M-2: a hand draft adopted as it is — a `#` map, `<key> · <Type> — <summary>` headings, tickets that already have a key
  const hand = (name, extra = '', unkeyed = false, change = (t) => t) => {
    const d = join(root, 'epics', name)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'JIRA.md'), change(`# Jira — loan renewal
Status: in Jira, epic ${HK(310)} · Updated: 2026-11-17

| # | Key | Type | Summary | Parent | Brief decisions |
|---|---|---|---|---|---|
| E | ${HK(310)} | Epic | Loan renewal | — | all |
| T0 | ${HK(620)} | Task | Spike: pick a barcode scanner | ${HK(310)} | D1 |
| T1 | ${HK(622)} | Story | Renew a loan | ${HK(310)} | D2, D5 |
| T1.1 | ${HK(314)} | Sub-task | [BE] Renewal handlers | ${HK(622)} | D2 |
| T1.2 | ${unkeyed ? '—' : HK(315)} | Sub-task | [FE Dashboard] Show renewal status | ${HK(622)} | D3 |

## ${HK(310)} · Epic

**Why**
The numbers are in ${HK(620)} and in data/Q2-usage.md; see D2 in the brief (§9).

## ${HK(620)} · Task (spike)

Pick the vendors, see F3.

## ${HK(622)} · Story — Renew a loan

Goal: P1.

## ${HK(314)} · Sub-task — [BE] Renewal handlers

**Deliverables**
1. Handlers.
${unkeyed ? '' : `\n## ${HK(315)} · Sub-task — [FE Dashboard] Show renewal status\n\nThe list shows a badge.\n`}${extra}`))
    return d
  }
  r = lint(hand('hand'))
  check('product-lint jira: an adopted hand draft (a "#" map, "<key> · <Type> — ..." headings, created tickets) gives no false findings', r.code === 0, r.out)
  r = lint(hand('hand-keyurl', '', false, (x) => x.replace(`| T1.2 | ${HK(315)} |`, `| T1.2 | https://jira.example/browse/${HK(315)} |`)))
  check('product-lint jira: a key cell that is not a Jira key (a pasted URL) is map-key-form', / — map-key-form — "https:\/\/jira\.example/.test(r.out), r.out)
  r = lint(hand('hand-open', '\n## (not created) [FE Dashboard] Show renewal status\n\n- WHEN a guest asks THEN the offer shows\n\n## (not created) [FE] Another screen\n\n**What**\nText.\n', true))
  check('product-lint jira: a ticket without a key in a hand draft is still read (id comment, [FE] app, criteria) and its map row is named', r.code === 1 && / — ticket-no-id — .*<!-- T1\.2 -->/.test(r.out) && / — fe-no-app — /.test(r.out) && / — subtask-no-criteria — /.test(r.out), r.out)

  // m-1: a keyed ticket skips the text rules only; the link rules read it too (id comment or the key at the start of the heading)
  const handLine = (d, re) => readFileSync(join(d, 'JIRA.md'), 'utf8').split('\n').findIndex((l) => re.test(l)) + 1
  const lookup = (d, key) => {
    const j = readJira(readFileSync(join(d, 'JIRA.md'), 'utf8'))
    return findTicket(j, key)
  }
  let h = hand('hand-lookup')
  check(`product-lint jira: a lookup for ${HK(315)} (key, map row, the heading with that key at its start) resolves to its heading`, lookup(h, HK(315)).row?.id === 'T1.2' && /^\[FE Dashboard\] Show renewal status$/.test(lookup(h, HK(315)).ticket?.summary ?? ''), JSON.stringify(lookup(h, HK(315)).ticket?.summary))
  check('lib/jira: a key the map does not have finds no row and no ticket', lookup(h, HK(999)).row === null && lookup(h, HK(999)).ticket === null)
  h = hand('hand-lookup-id', '', false, (t) => t.replace(`## ${HK(315)} · Sub-task — [FE Dashboard] Show renewal status`, `## ${HK(315)} · Sub-task — [FE Dashboard] Show renewal status <!-- T1.2 -->`))
  check(`lib/jira: a heading that has both the key and the id comment is found for ${HK(315)}`, lookup(h, HK(315)).ticket?.id === 'T1.2' && lint(h).code === 0, lint(h).out)
  h = hand('hand-no-heading', '', false, (t) => t.replace(new RegExp(`^## ${HK(315)} .*\\n\\nThe list shows a badge\\.\\n`, 'm'), ''))
  r = lint(h)
  check('product-lint jira: a key map row with a key and no heading is map-no-ticket at the row, naming the key', r.code === 1 && hit(r.out, 10, 'map-no-ticket') && new RegExp(`or with ${HK(315)} at its start`).test(r.out) && lookup(h, HK(315)).ticket === null, r.out)
  h = hand('hand-key-no-row', '', false, (t) => t.replace(`## ${HK(314)} · Sub-task`, `## ${HK(499)} · Sub-task`))
  r = lint(h)
  check('product-lint jira: a heading key that is on no map row is ticket-not-in-map at the heading', hit(r.out, handLine(h, new RegExp(`^## ${HK(499)}`)), 'ticket-not-in-map') && hit(r.out, 9, 'map-no-ticket'), r.out)
  h = hand('hand-key-mismatch', '', false, (t) => t.replace(`## ${HK(314)} · Sub-task — [BE] Renewal handlers`, `## ${HK(314)} · Sub-task — [BE] Renewal handlers <!-- T1.2 -->`))
  r = lint(h)
  check('product-lint jira: a heading whose key is not the Key of the row its id comment names is ticket-key-mismatch', hit(r.out, handLine(h, new RegExp(`^## ${HK(314)}`)), 'ticket-key-mismatch'), r.out)
  h = hand('hand-two-ids', '', false, (t) => t.replace(`## ${HK(314)} · Sub-task — [BE] Renewal handlers`, `## ${HK(314)} · Sub-task — [BE] Renewal handlers <!-- T1.1 -->`).replace(`## ${HK(315)} · Sub-task — [FE Dashboard] Show renewal status`, `## ${HK(315)} · Sub-task — [FE Dashboard] Show renewal status <!-- T1.1 -->`))
  r = lint(h)
  check('product-lint jira: two keyed headings with one id comment are ticket-id-duplicate at the second', hit(r.out, handLine(h, new RegExp(`^## ${HK(315)}`)), 'ticket-id-duplicate') && hit(r.out, 10, 'map-no-ticket'), r.out)
  h = hand('hand-same-key', '', false, (t) => t.replace(new RegExp(`^(\\| T1\\.2 \\| )${HK(315)}`, 'm'), `$1${HK(314)}`))
  r = lint(h)
  check('product-lint jira: one key on two map rows is map-key-duplicate at the second row', hit(r.out, 10, 'map-key-duplicate'), r.out)
  h = hand('hand-keyed-text', '', false, (t) => t.replace('The list shows a badge.', 'It builds on D3 and §2.'))
  check('product-lint jira: a keyed ticket still skips the text rules', lint(h).code === 0, lint(h).out)

  // m-3: placeholders of the template in any ticket text line (the template's own forms; header and key map are not read)
  e = jira('half-criterion', (t) => t.replace(/(### (?:Task|Sub-task): \[FE Dashboard\][\s\S]*?)^- WHEN.*$/m, '$1- WHEN a guest asks THEN <observable result>'))
  check('product-lint jira: a half-filled criterion keeps its placeholder: placeholder-left', hit(lint(e).out, lineOf(e, /^- WHEN a guest asks THEN <observable/), 'placeholder-left'), lint(e).out)
  for (const [label, from, to] of [['What', /^(\*\*What\*\*\n)Written out\.$/m, '$1<One or two sentences.>'], ['Out of scope', /^\*\*Out of scope:\*\* Written out\.$/m, '**Out of scope:** <what this subtask leaves alone.>'], ['Depends on', /^\*\*Depends on:\*\* Written out\.$/m, '**Depends on:** <the decision written out as "question: recommendation → who decides", or "none".>']]) {
    e = jira(`ph-${label.replace(/\W/g, '')}`, (t) => t.replace(from, to))
    check(`product-lint jira: a placeholder left in "${label}" is placeholder-left`, / — placeholder-left — /.test(lint(e).out) && lint(e).code === 1, lint(e).out)
  }
  e = jira('ph-partner', addToText('The <PARTNER> field and a <b>bold</b> tag are real text.'))
  check('product-lint jira: a real <PARTNER>-like token is not a placeholder of the template', lint(e).code === 0, lint(e).out)
  e = jira('ph-header', (t) => t.replace(/^Updated:.*$/m, 'Updated: <YYYY-MM-DD>'))
  check('product-lint jira: the header keeps its placeholders (not ticket text)', lint(e).code === 0, lint(e).out)

  // m-4: a path into the epic from anywhere, and the two layout files
  for (const [label, text] of [['<company>-product/epics/<slug>/research/x.md', 'The matrix: acme-product/epics/early/research/partner-matrix.md is long.'], ['epics/<slug>/data/x.out', 'The numbers: epics/early/data/q-usage.out.'], ['JIRA.md', 'The draft is JIRA.md.'], ['PROJECT.md', 'See PROJECT.md for the apps.'], ['handoff/', 'The text is in handoff/ABC-1.md.']]) {
    e = jira(`epicfile-${label.replace(/\W/g, '')}`, addToText(text))
    r = lint(e)
    check(`product-lint jira: "${label}" in a ticket text is one ticket-epic-file finding`, hit(r.out, lineOf(e, new RegExp(`^${text.slice(0, 12).replace(/\W/g, '.')}`)), 'ticket-epic-file') && count(r.out) === 1, r.out)
  }
  e = jira('epics-url', addToText('Docs at https://example.com/epics/early/data.html are public.'))
  check('product-lint jira: a URL that contains epics/<slug>/ is not a path into the epic', lint(e).code === 0, lint(e).out)

  // m-5: a heading with an id comment is a ticket whatever its form; the map survives a bad row
  e = jira('spike-form', addTicket('T0', '### Task (spike)', '**What**\nText.', '(spike)'))
  check('product-lint jira: "Task (spike) <!-- T0 -->" (no separator) is a ticket linked by its id comment', lint(e).code === 0, lint(e).out)
  e = jira('story-nosep', addTicket('T2', '### Story Cheap rooms', '**Goal**\nText.', 'Cheap rooms'))
  check('product-lint jira: "Story Cheap rooms <!-- T2 -->" is a ticket linked by its id comment', lint(e).code === 0, lint(e).out)
  e = jira('bad-row', (t) => t.replace(/^(\| T1\.2 \|.*)$/m, '$1\n| E1 | — | Sub-task | Extra | T1 | — | — | 9 |'))
  r = lint(e)
  check('product-lint jira: one row with an id that is no id is map-bad-id at that row, the map is still read', hit(r.out, lineOf(e, /^\| E1 \|/), 'map-bad-id') && !/key-map-missing|ticket-epic-id/.test(r.out) && count(r.out) === 1, r.out)
  e = jira('bad-rows', (t) => t.replace(/^\| T1 \|/m, '| X1 |').replace(/^\| T1\.1 \|/m, '| X2 |').replace(/^\| T1\.2 \|/m, '| X3 |'))
  check('product-lint jira: a table whose first cells are mostly no ids is not the key map', hit(lint(e).out, 1, 'key-map-missing'), lint(e).out)

  // m-8: a keyed story does not hide the unkeyed subtask under it; an App repos table in a comment names no app
  e = jira('nested-subtask', (t) => t.replace(/^(\| T1 \| )—/m, `$1${HK(7)}`).replace(/^### Sub-task: \[BE\]/m, '#### Sub-task: [BE]').replace(/^(\*\*What\*\*\n)Written out\.$/m, '$1Builds on D3 and §2.'))
  r = lint(e)
  check('product-lint jira: a keyed story ends at the next ticket heading: the unkeyed subtask under it is read', hit(r.out, lineOf(e, /^Builds on D3/), 'ticket-epic-id') && hit(r.out, lineOf(e, /^Builds on D3/), 'ticket-section-ref'), r.out)
  writeFileSync(join(root, 'PROJECT.md'), project.replace(/^## App repos\n/m, '## App repos\n<!--\n| Repo | Path |\n|---|---|\n| Ghost | /nowhere |\n-->\n'))
  e = jira('ghost-app', (t) => t.replaceAll('[FE Dashboard]', '[FE Ghost]'))
  check('product-lint jira: an app named only in a table inside a comment is not an app', hit(lint(e).out, lineOf(e, /^### Sub-task: \[FE Ghost\]/), 'fe-unknown-app'), lint(e).out)
  writeFileSync(join(root, 'PROJECT.md'), project)

  // M-4: the skeleton stays English, the prose may be any language
  const RU = `${String.fromCharCode(0x41f, 0x440, 0x438, 0x432, 0x435, 0x442)} ${String.fromCharCode(0x43c, 0x438, 0x440)}`
  e = jira('prose', (t) => t.replace(/^\*\*Why\*\*$/m, `**Why**\n${RU}.`).replace(/^2\. The availability check behind the contract\.$/m, `2. ${RU}.`).replace(/^\*\*What\*\*\nWritten out\./m, `**What**\n${RU}.`))
  check('product-lint jira: non-English prose under the English skeleton lints clean', lint(e).code === 0, lint(e).out)
  check('templates: JIRA says the skeleton stays English and the id comment stays', /skeleton stays English/.test(tpl) && /id comment|Id, as in the headings/.test(tpl) && /^### Sub-task: \[BE\] <summary> <!-- T1\.1 -->$/m.test(tpl))

  // M-5: the heading and the key map row are one ticket
  e = jira('map-typo', (t) => t.replace(/^(\| T1\.2 \| — \| Sub-task \| \[FE Dashboard\] Show availability on offers)/m, '$1x'))
  r = lint(e)
  check('product-lint jira: a map summary that differs from the heading is map-summary at the heading', r.code === 1 && hit(r.out, lineOf(e, /^### Sub-task: \[FE Dashboard\]/), 'map-summary') && count(r.out) === 1, r.out)
  e = jira('no-id', (t) => t.replace(' <!-- T1.1 -->', ''))
  r = lint(e)
  check('product-lint jira: a heading without an id comment is ticket-no-id (naming the row by its summary) and its row is not reported twice', hit(r.out, lineOf(e, /^### Sub-task: \[BE\]/), 'ticket-no-id') && /<!-- T1\.1 -->/.test(r.out) && count(r.out) === 1, r.out)
  e = jira('foreign-id', (t) => t.replace('<!-- T1.1 -->', '<!-- T7 -->'))
  r = lint(e)
  check('product-lint jira: an id comment that no map row has is ticket-not-in-map, and the row without a heading is map-no-ticket', hit(r.out, lineOf(e, /^### Sub-task: \[BE\]/), 'ticket-not-in-map') && hit(r.out, lineOf(e, /^\| T1\.1 \|/), 'map-no-ticket'), r.out)
  e = jira('two-same-id', (t) => t.replace('<!-- T1.2 -->', '<!-- T1.1 -->'))
  check('product-lint jira: two headings with one id are ticket-id-duplicate', hit(lint(e).out, lineOf(e, /^### Sub-task: \[FE Dashboard\]/), 'ticket-id-duplicate'), lint(e).out)
  e = jira('same-summary', (t) => t.replaceAll('[BE] Availability check for the vendor', '[FE Dashboard] Show availability on offers'))
  check('product-lint jira: two tickets with one summary are summary-duplicate once, at the second heading', / — summary-duplicate — .*line 45/.test(lint(e).out) && count(lint(e).out) === 1, lint(e).out)
  e = jira('no-map', (t) => t.replace(/^\| T \| Key[\s\S]*?\n\n/m, ''))
  check('product-lint jira: a JIRA.md without a key map is key-map-missing', hit(lint(e).out, 1, 'key-map-missing'), lint(e).out)
  e = jira('map-row-no-ticket', (t) => t.replace(/^(\| T1\.2 \|.*)$/m, '$1\n| T1.3 | — | Sub-task | [Design] Mockups | T1 | — | — | 9 |'))
  check('product-lint jira: a key map row with no ticket heading is map-no-ticket at the row', hit(lint(e).out, lineOf(e, /^\| T1\.3 \|/), 'map-no-ticket'), lint(e).out)
  e = jira('keyed-row', (t) => t.replace(/^(\| T1\.1 \| )—/m, '$1APP-8').replace(/^(\*\*What\*\*\n)Written out\.$/m, '$1Builds on D3 and §2.'))
  check('product-lint jira: a ticket whose map row has a Jira key is not read (created tickets belong to the drift check)', lint(e).code === 0, lint(e).out)

  // m-2, m-3: placeholders and labels
  e = jira('placeholder', (t) => t.replace(/(### (?:Task|Sub-task): \[FE Dashboard\][\s\S]*?)^- WHEN.*$/m, '$1- WHEN <condition> THEN <observable result>'))
  r = lint(e)
  check('product-lint jira: a criterion that keeps the template placeholders is placeholder-left, once', r.code === 1 && hit(r.out, lineOf(e, /^- WHEN <condition>/), 'placeholder-left') && count(r.out) === 1, r.out)
  e = jira('prose-open-decisions', (t) => t.replace(/^\*\*Open decisions\*\*/m, 'Two open decisions block the second release.\n\n**Open decisions**'))
  check('product-lint jira: prose that mentions "open decisions" above the label is not the label', lint(e).code === 0, lint(e).out)
  e = jira('prose-label-word', (t) => t.replace(/^\*\*Open decisions\*\*/m, 'Open decisions are listed below.\n\n**Open decisions**'))
  check('product-lint jira: a prose line that starts with "Open decisions" is not the label', lint(e).code === 0, lint(e).out)
  e = jira('epic-by-word', (t) => t.replace('| Epic | Slot swap |', '| Epic | Slot swap epic |').replace(/^### Epic: Slot swap/m, '### Slot swap epic'))
  check('product-lint jira: the epic is found by the word Epic anywhere in its heading', lint(e).code === 0, lint(e).out)
  e = jira('open-prose-only', (t) => t.replace(/^\*\*Open decisions\*\*.*\n- .*$/m, 'Two open decisions block the second release.\n- an item of some list'))
  check('product-lint jira: prose that mentions "open decisions" is not the label (no label: a finding at the heading)', hit(lint(e).out, lineOf(e, /^### Epic:/), 'epic-no-open-decisions'), lint(e).out)
  e = jira('deliverables-inline', (t) => t.replace(/^\*\*Deliverables\*\*\n1\..*\n2\..*$/m, '**Deliverables:** the API contract first, then the check.'))
  check('product-lint jira: "**Deliverables:** the API contract ..." on one line is accepted', lint(e).code === 0, lint(e).out)
  e = jira('contracts-plural', (t) => t.replace(/^1\. The API contract.*$/m, '1. The API contracts, reviewed by the frontend.'))
  check('product-lint jira: "contracts" counts as the contract', lint(e).code === 0, lint(e).out)
  e = jira('inline-no-contract', (t) => t.replace(/^\*\*Deliverables\*\*\n1\..*\n2\..*$/m, '**Deliverables:** the check first.'))
  check('product-lint jira: an inline first deliverable without the contract is a finding at the label', hit(lint(e).out, lineOf(e, /^\*\*Deliverables:\*\*/), 'be-no-contract'), lint(e).out)
  e = jira('label-bare', (t) => t.replace(/^\*\*Deliverables\*\*\n1\..*\n2\..*\n\n/m, '**Deliverables**\n\n').replace(/^(\*\*Criteria\*\*\n- WHEN a guest asks for slot swap THEN the offer shows only when a room is free)/m, '$1\n- WHEN the API contract changes THEN the frontend is told'))
  check('product-lint jira: a Deliverables label with no list is a finding even when a criterion says "contract"', hit(lint(e).out, lineOf(e, /^### Sub-task: \[BE\]/), 'be-no-contract'), lint(e).out)
  e = jira('no-label', (t) => t.replace(/^\*\*Deliverables\*\*\n/m, 'Contract first: reviewed by the frontend.\n').replace(/^1\. The API contract.*\n/m, ''))
  check('product-lint jira: a [BE] subtask without the Deliverables label is a finding even with a "Contract first" line', hit(lint(e).out, lineOf(e, /^### Sub-task: \[BE\]/), 'be-no-contract'), lint(e).out)

  // M-7: one App repos reader, by column name
  writeFileSync(join(root, 'PROJECT.md'), project.replace(/^\| Repo \| Path \| task_path \| What it is \| Label \|$/m, '| Path | Repo | task_path | What it is |').replace(/^\| Dashboard \| ~\/dashboard \|/m, '| ~/web-one | Dashboard |').replace(/^\| Guest app \| ~\/guest \|/m, '| ~/web-two | Guest app |'))
  check('product-lint jira: the apps are read by the Repo column, not by position', lint(jira('swapped-cols')).code === 0, lint(jira('swapped-cols')).out)
  writeFileSync(join(root, 'PROJECT.md'), project)

  // text mode: a message draft before it is shown
  {
    const draft = join(root, 'draft.md')
    const textLint = (file, ...extra) => run(join(ROOT, 'scripts/product-lint.mjs'), root, '--mode', 'text', ...(file ? ['--file', file] : []), ...extra)
    writeFileSync(draft, 'Hello.\n\n1. Waiting for D3, see section §2 and P1.\n2. As in the brief. Data in data/Q1-usage.md.\nIn Q1 2027 it ships.\n')
    r = textLint(draft)
    check('product-lint text: a draft with epic ids, a section reference, "brief" and a path gives findings at their lines', r.code === 1 && /draft\.md:3 — ticket-epic-id — D3/.test(r.out) && /draft\.md:3 — ticket-epic-id — P1/.test(r.out) && /draft\.md:3 — ticket-section-ref/.test(r.out) && /draft\.md:4 — ticket-brief-ref/.test(r.out) && /draft\.md:4 — ticket-epic-file/.test(r.out) && !/draft\.md:5/.test(r.out), r.out)
    writeFileSync(draft, 'Hello.\n\n1. The vendor choice: I suggest the larger one. It costs two weeks.\n')
    check('product-lint text: a clean draft passes', textLint(draft).code === 0, textLint(draft).out)
    writeFileSync(draft, 'Hello.\n\n1. The vendor choice: <observable result>.\n')
    check('product-lint text: a placeholder of the template left in a draft is placeholder-left at its line', /draft\.md:3 — placeholder-left/.test(textLint(draft).out), textLint(draft).out)
    check('product-lint text: without --file it exits 2', textLint(null).code === 2, textLint(null).out)
    // m-1: --template message checks a message draft against templates/message.md; the default is JIRA.md
    writeFileSync(draft, 'Hello.\n\n1. The vendor choice: I suggest the larger one. It costs <effort, risk, what breaks, who pays>.\n')
    check('product-lint text: a placeholder of message.md left in a message draft is invisible by default (the JIRA.md placeholders) and a finding with --template message', textLint(draft).code === 0 && /draft\.md:3 — placeholder-left — <effort, risk, what breaks, who pays>/.test(textLint(draft, '--template', 'message').out), `${textLint(draft).out}\n${textLint(draft, '--template', 'message').out}`)
    writeFileSync(draft, '<Greeting.> Hello.\n')
    check('product-lint text: <Greeting.> from message.md is placeholder-left with --template message', /placeholder-left — <Greeting\.>/.test(textLint(draft, '--template', 'message').out), textLint(draft, '--template', 'message').out)
    writeFileSync(draft, 'Hello.\n\n1. The vendor choice: I suggest the larger one. It costs two weeks.\n')
    check('product-lint text: a clean message passes with --template message; an unknown template exits 2', textLint(draft, '--template', 'message').code === 0 && textLint(draft, '--template', 'x').code === 2, textLint(draft, '--template', 'x').out)
    // M-3: the stakeholder version of the brief is linted before it is shown: ids are findings, the word "brief" is let through with --allow brief
    writeFileSync(draft, '# Early plan — product brief\n\nHosts approve most requests by hand (F1). Waiting for D3.\n')
    r = textLint(draft)
    const allowed = textLint(draft, '--allow', 'brief')
    check('product-lint text: a stakeholder brief draft with (F1) is ticket-epic-id; "brief" in its title is a finding by default and not with --allow brief', /draft\.md:3 — ticket-epic-id — F1/.test(allowed.out) && /draft\.md:3 — ticket-epic-id — D3/.test(allowed.out) && !/ticket-brief-ref/.test(allowed.out) && /draft\.md:1 — ticket-brief-ref/.test(r.out) && allowed.code === 1, `${r.out}\n${allowed.out}`)
    writeFileSync(draft, '# Early plan — product brief\n\nHosts approve most requests by hand.\n')
    check('product-lint text: --allow brief on a clean stakeholder version passes', textLint(draft, '--allow', 'brief').code === 0, textLint(draft, '--allow', 'brief').out)
  }

  // the contract's id table is what is banned: a letter added there is read, without it the letter is free
  const copyDir = copy()
  const xText = readFileSync(join(root, 'epics/clean/JIRA.md'), 'utf8').replace(/^\*\*Why\*\*$/m, '**Why**\nThe item X5 is open.')
  edit(copyDir, 'references/product-repo.md', (t) => fill(t, /^(\| `T<n>` .*\n)/m, '$1| `X<n>` | an extra id | BRIEF.md | STATUS.md |\n', 'contract'))
  mkdirSync(join(copyDir, 'epics/x'), { recursive: true })
  writeFileSync(join(copyDir, 'epics/x/JIRA.md'), xText)
  writeFileSync(join(copyDir, 'PROJECT.md'), project)
  r = run(join(copyDir, 'scripts/product-lint.mjs'), join(copyDir, 'epics/x'), '--mode', 'jira')
  check('product-lint jira: the banned ids come from the contract table (an X<n> row added there makes X5 a finding)', r.code === 1 && / — ticket-epic-id — X5 is an epic id/.test(r.out), r.out)
  mkdirSync(join(root, 'epics/x5'), { recursive: true })
  writeFileSync(join(root, 'epics/x5/JIRA.md'), xText)
  r = lint(join(root, 'epics/x5'))
  check('product-lint jira: without the X<n> row in the contract X5 is not an epic id', !/ticket-epic-id/.test(r.out), r.out)
  edit(copyDir, 'references/product-repo.md', () => 'no table here\n')
  r = run(join(copyDir, 'scripts/product-lint.mjs'), join(copyDir, 'epics/x'), '--mode', 'jira')
  check('product-lint jira: an unreadable id table exits 2', r.code === 2, r.out)
  rmSync(copyDir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
}

// product-lint, handoff mode, and scripts/handoff.mjs: a fixture product repo with JIRA.md, STATUS.md, PROJECT.md and an app repo
{
  const root = mkdtempSync(join(tmpdir(), 'product-handoff-'))
  const appDir = join(root, 'dashboard')
  const lintBin = join(ROOT, 'scripts/product-lint.mjs')
  const handoffBin = join(ROOT, 'scripts/handoff.mjs')
  mkdirSync(join(appDir, '.claude'), { recursive: true })
  mkdirSync(join(root, 'epics/early/data'), { recursive: true })
  writeFileSync(join(root, 'PROJECT.md'), fill(readFileSync(join(ROOT, 'templates/PROJECT.md'), 'utf8'), /^\| <dashboard> \|.*$/m, `| Dashboard | ${appDir} | .claude/tasks/ | web app |`, 'PROJECT.md'))
  writeFileSync(join(root, 'PROJECT.md'), `${readFileSync(join(root, 'PROJECT.md'), 'utf8')}\nProduct design: https://www.figma.com/design/proj/All-screens\n`)
  const epicDir = join(root, 'epics/early')
  writeFileSync(join(epicDir, 'data/Q1-vendor-share.md'), '# Q1 — Vendor share of offers\n\nStatus: open\n')
  writeFileSync(join(epicDir, 'STATUS.md'), [
    '# Slot swap — product status', '', '## Open decisions',
    '| Id | Question | Recommendation | Owner | State |', '|---|---|---|---|---|',
    '| D1 | Which vendor first | the larger one | Dana | open |',
    '| D2 | Share of offers per vendor | — | Dana | pending data Q1 |',
    '| D3 | Show the offer to all guests | yes, to all | Sam | decided 2026-11-10 Sam |',
    '| D4 | Badge colour | green | Sam | maybe later |', '',
  ].join('\n'))
  const JIRA = [
    '# Slot swap — Jira', '', 'Status: created', '', '## Key map',
    '| T | Key | Type | Summary | Parent | Blocked by | Decisions | Order |', '|---|---|---|---|---|---|---|---|',
    '| E | APP-10 | Epic | Slot swap | — | — | all | 1 |',
    '| T1 | APP-11 | Story | Offer availability | E | — | D1 | 2 |',
    '| T1.1 | APP-12 | Sub-task | [BE] Availability check for the vendor | T1 | — | D1, D2 | 3 |',
    '| T1.2 | APP-13 | Sub-task | [FE Dashboard] Show availability on offers | T1 | T1.1 | D3 | 4 |',
    '| T1.3 | APP-14 | Sub-task | [Design] Offer card | T1 | — | — | 5 |',
    '| T1.4 | APP-15 | Sub-task | [FE Dashboard] Offer settings | T1 | — | — | 6 |',
    '| T1.5 | APP-16 | Sub-task | [FE Dashboard] Vendor badge | T1 | T1.1 | D1, D9, D4 | 7 |', '', '## Tickets', '',
    '### Epic: Slot swap <!-- E -->', '', '**Why**', 'Hosts lose offers.', '',
    '### Story: Offer availability <!-- T1 -->', '', '**Goal**', 'Guests see free rooms.', '',
    '### Sub-task: [BE] Availability check for the vendor <!-- T1.1 -->', '', '**What**', 'Checks the vendor.', '',
    '**Deliverables**', '1. The API contract, reviewed by the frontend before implementation.', '2. The check.', '',
    '**Criteria**', '- WHEN the vendor answers THEN the offer is marked available', '', '**Depends on:** none', '', '**Out of scope:** Payments.', '',
    '### Sub-task: [FE Dashboard] Show availability on offers <!-- T1.2 -->', '', '**What**', 'Shows it. Design: https://www.figma.com/design/abc/Offers?node-id=1-2', '',
    '**Criteria**', '- WHEN a guest asks for slot swap THEN the offer shows only when a room is free', '- The offer does not flash on load', '',
    '**Depends on:** "[BE] Availability check for the vendor" for the contract.', '',
    '**Out of scope:**', '- Payment for the offer.', '- Offers for groups.', '',
    '### Sub-task: [Design] Offer card <!-- T1.3 -->', '', '**What**', 'The card.', '',
    '### Sub-task: [FE Dashboard] Offer settings <!-- T1.4 -->', '', '**What**', 'Settings. Design: https://www.figma.com/design/xyz/Settings?node-id=3-4.', '',
    '**Criteria**', '- WHEN the host opens the settings THEN the offer switch is shown', '', '**Notes**', '- Ask QA to test on Safari', '',
    '**Depends on:** the rooms service of the property team.', '',
    '### Sub-task: [FE Dashboard] Vendor badge <!-- T1.5 -->', '', '**What**', 'A badge.', '',
    '**Criteria**', '- WHEN the vendor is known THEN the card shows its badge', '',
  ].join('\n')
  writeFileSync(join(epicDir, 'JIRA.md'), JIRA)
  const gen = (key, ...extra) => {
    const r = run(handoffBin, epicDir, key, '--json', ...extra)
    let j = null
    try { j = JSON.parse(r.out.slice(r.out.indexOf('{'))) } catch { /* the check below shows r.out */ }
    return { ...r, j }
  }
  const lintFile = (path) => run(lintBin, epicDir, '--mode', 'handoff', '--file', path)

  // AC-6.1: a [FE <app>] ticket of the fixture
  const fe = gen('APP-13')
  check('handoff.mjs: a [FE <app>] ticket gives the file path in the app repo, the marker, the header and the next steps', fe.code === 0 && fe.j?.target === join(appDir, '.claude/tasks/APP-13/PRODUCT-HANDOFF.md') && fe.j.content.startsWith('<!-- product-handoff 1 -->\n# APP-13: Show availability on offers\n') && /^Type: \[FE Dashboard\]$/m.test(fe.j.content) && /^App\/Repo: Dashboard$/m.test(fe.j.content) && /^From: .+ · epics\/early$/m.test(fe.j.content) && /^Design source: https:\/\/www\.figma\.com\/design\/abc\/Offers\?node-id=1-2$/m.test(fe.j.content) && /^Contract: the contract of "Availability check for the vendor" \(APP-12\)$/m.test(fe.j.content) && fe.j.copy === join(epicDir, 'handoff/APP-13.md') && fe.j.next.join('|') === `cd '${appDir}'|/stage-pipeline:feature-checker APP-13|/stage-pipeline:stage-plan APP-13`, fe.out)
  const c = fe.j?.content ?? ''
  check('handoff.mjs: H1 comes from the ticket criterion as written; one that is not WHEN/THEN is marked "rewritten from the ticket" and reported', /^- `H1` WHEN a guest asks for slot swap THEN the offer shows only when a room is free$/m.test(c) && /^- `H2` WHEN <condition> THEN <observable result> \(rewritten from the ticket\) <!-- src: [0-9a-f]{8} -->$/m.test(c) && fe.j.rewritten.length === 1 && fe.j.rewritten[0].original === 'The offer does not flash on load' && fe.j.warnings.some((w) => /H2 is not in the form/.test(w)), fe.out)
  check('handoff.mjs: decisions are words with owner and state, no D<n>, a decided one is not a question', /^- Show the offer to all guests — yes, to all — Sam — decided 2026-11-10$/m.test(c) && !/\bD\d\b/.test(c) && !/^## Open questions\n- .*Show the offer/m.test(c), c)
  check('handoff.mjs: out of scope comes from the ticket, line by line', /^## Out of scope\n- Payment for the offer\.\n- Offers for groups\.$/m.test(c), c)
  // AC-6.3: a task that depends on an open decision: a warning and a line in Open questions
  const be = gen('APP-12', '--repo', 'Dashboard')
  const bc = be.j?.content ?? ''
  check('handoff.mjs: an open decision the task depends on is a warning and a line in Open questions, with the words and no D<n>', be.code === 0 && be.j.warnings.some((w) => /open decision the task depends on.*Which vendor first/.test(w)) && /^## Open questions\n- Which vendor first — Dana — blocks /m.test(bc) && /^- Which vendor first — the larger one — Dana — open$/m.test(bc) && !/\bD\d\b/.test(bc), be.out)
  check('handoff.mjs: a decision that waits for data is "open — waits for data: <what>" with no Q<n>, no recommendation invented', /^- Share of offers per vendor — no recommendation yet — Dana — open — waits for data: Vendor share of offers$/m.test(bc) && !/\bQ\d\b/.test(bc), bc)
  check('handoff.mjs: a [BE] ticket says stage 1 is the contract; the open decisions of the ticket that blocks an FE ticket reach it too, marked by their origin', /^Contract: stage 1 is the contract$/m.test(bc) && /^Type: \[BE\]$/m.test(bc) && fe.j.openDecisions.length === 2 && fe.j.warnings.some((w) => /from T1\.1/.test(w)), bc)
  check('handoff.mjs: a [BE] ticket with no Figma link gets "none", never the first link of PROJECT.md', /^Design source: none$/m.test(bc), bc)
  // M-2: an [FE] ticket without a link of its own: the placeholder and a warning (never "none"); the [Design] subtask of the same parent is searched first
  {
    const noDesign = gen('APP-16')
    check('handoff.mjs: an [FE] ticket with no design anywhere gets the template placeholder (the lint rejects it) and a warning, never "none"', /^Design source: <Figma URL, prototype path, or "none">$/m.test(noDesign.j?.content ?? '') && noDesign.j.warnings.some((w) => /no Figma link or prototype path.*\[Design\] subtask that blocks it or shares its parent/.test(w)) && lintFile((writeFileSync(join(root, 'nd.md'), noDesign.j.content.replace(/blocks H<n>:/g, 'blocks H1:')), join(root, 'nd.md'))).out.includes('placeholder-left'), noDesign.out)
    writeFileSync(join(epicDir, 'JIRA.md'), JIRA.replace('### Sub-task: [Design] Offer card <!-- T1.3 -->\n\n**What**\nThe card.', '### Sub-task: [Design] Offer card <!-- T1.3 -->\n\n**What**\nThe card. Mockups: https://www.figma.com/design/card/Offers?node-id=7-8).'))
    const viaDesign = gen('APP-16')
    check('handoff.mjs: the Figma link of the [Design] subtask of the same parent is the design source of the [FE] ticket, with a warning to check it', /^Design source: https:\/\/www\.figma\.com\/design\/card\/Offers\?node-id=7-8$/m.test(viaDesign.j?.content ?? '') && viaDesign.j.warnings.some((w) => /comes from the \[Design\] subtask/.test(w)) && !viaDesign.j.warnings.some((w) => /no Figma link or prototype path/.test(w)), viaDesign.out)
    const own = gen('APP-13')
    check('handoff.mjs: the ticket\'s own Figma link wins over the [Design] subtask\'s', /^Design source: https:\/\/www\.figma\.com\/design\/abc\/Offers\?node-id=1-2$/m.test(own.j?.content ?? '') && !own.j.warnings.some((w) => /comes from the \[Design\]/.test(w)), own.out)
    const beStill = gen('APP-12', '--repo', 'Dashboard')
    check('handoff.mjs: a [BE] ticket keeps "none" even when a [Design] subtask has a link', /^Design source: none$/m.test(beStill.j?.content ?? '') && !beStill.j.warnings.some((w) => /Design source|design source/.test(w)), beStill.out)
    writeFileSync(join(epicDir, 'JIRA.md'), JIRA.replace('| T1.3 | APP-14 | Sub-task | [Design] Offer card | T1 |', '| T1.3 | APP-14 | Sub-task | [Design] Offer card | T9 |').replace('**What**\nThe card.', '**What**\nThe card. https://www.figma.com/design/other/Elsewhere'))
    const otherParent = gen('APP-16')
    check('handoff.mjs: a [Design] subtask of another parent is not a design source (the placeholder stays)', /^Design source: <Figma URL/m.test(otherParent.j?.content ?? '') && !/Elsewhere/.test(otherParent.j?.content ?? ''), otherParent.out)
    writeFileSync(join(epicDir, 'JIRA.md'), JIRA.replace('### Sub-task: [Design] Offer card <!-- T1.3 -->\n\n**What**\nThe card.', '### Sub-task: [Design] Offer card <!-- T1.3 -->\n\n**What**\nThe card.\nPrototype: prototypes/offers/index.html'))
    const proto = gen('APP-16')
    check('handoff.mjs: a prototype path in the [Design] subtask is a design source too', /^Design source: prototypes\/offers\/index\.html$/m.test(proto.j?.content ?? ''), proto.out)
    writeFileSync(join(epicDir, 'JIRA.md'), JIRA)
  }
  // the survivors of the mutation run: each rule has a fixture
  let r
  const badge = gen('APP-16')
  const kc = badge.j?.content ?? ''
  check('handoff.mjs: a decision named by the ticket and by its blocker is written once, with its open question once', (kc.match(/Which vendor first/g) ?? []).length === 2 && (kc.match(/^- Which vendor first — the larger one/gm) ?? []).length === 1 && (kc.match(/^- Which vendor first — Dana — blocks/gm) ?? []).length === 1, kc)
  check('handoff.mjs: a decision that is in neither STATUS.md nor BRIEF.md is a placeholder line the lint rejects, with a warning', /^- <question> — <decision or recommendation> — <who decides> — open$/m.test(kc) && badge.j.warnings.some((w) => /D9 is in the key map but in neither STATUS\.md nor BRIEF\.md/.test(w)), kc)
  check('handoff.mjs: a decision state that is not open, pending data or decided is a warning and is written as open', badge.j.warnings.some((w) => /D4 has the state "maybe later"/.test(w)) && /^- Badge colour — green — Sam — open$/m.test(kc), kc)
  const settings = gen('APP-15')
  const sc = settings.j?.content ?? ''
  check('handoff.mjs: a list under another label (**Notes**) is not a criterion; a trailing period is cut from the Figma link', /^- `H1` WHEN the host opens the settings THEN the offer switch is shown\n\n/m.test(sc) && !/Safari/.test(sc) && /^Design source: https:\/\/www\.figma\.com\/design\/xyz\/Settings\?node-id=3-4$/m.test(sc), sc)
  check('handoff.mjs: "depends on" that is no decision of the key map is a warning; a ticket with no decisions says "- none" (the form the lint accepts), also in Out of scope and Open questions', settings.j.warnings.some((w) => /says it depends on something that is not a decision.*rooms service/.test(w)) && /^## Decisions\n- none\n/m.test(sc) && /^## Open questions\n- none\n?$/m.test(sc) && /^## Out of scope\n- none\n/m.test(sc) && settings.j.warnings.some((w) => /names nothing out of scope/.test(w)), sc)
  const sf = join(root, 'settings.md')
  writeFileSync(sf, sc)
  r = lintFile(sf)
  check('handoff.mjs + product-lint: a ticket with no decisions (the key map has "—") lints clean', r.code === 0, `${r.out}\n${sc}`)
  r = run(handoffBin, epicDir, 'APP-12')
  check('handoff.mjs: a [BE] ticket without --repo exits 1 and lists the app repos', r.code === 1 && /--repo/.test(r.out) && /Dashboard/.test(r.out), r.out)
  // the Label column: [FE Dashboard] names the app repo web-dashboard
  {
    const root2 = join(root, 'labelled')
    mkdirSync(root2, { recursive: true })
    cpSync(epicDir, join(root2, 'epics/early'), { recursive: true })
    const proj = (row) => fill(readFileSync(join(ROOT, 'templates/PROJECT.md'), 'utf8'), /^\| <dashboard> \|.*$/m, row, 'PROJECT.md')
    const gen2 = (...args) => {
      const x = run(handoffBin, join(root2, 'epics/early'), ...args, '--json')
      let j = null
      try { j = JSON.parse(x.out.slice(x.out.indexOf('{'))) } catch { /* shown by x.out */ }
      return { ...x, j }
    }
    writeFileSync(join(root2, 'PROJECT.md'), proj(`| web-dashboard | ${appDir} | .claude/tasks/ | web app | Dashboard |`))
    let x = gen2('APP-13')
    check('handoff.mjs: [FE Dashboard] finds the app repo web-dashboard by its Label', x.code === 0 && x.j?.appRepo === 'web-dashboard' && x.j.target === join(appDir, '.claude/tasks/APP-13/PRODUCT-HANDOFF.md') && /^Type: \[FE Dashboard\]$/m.test(x.j.content) && /^App\/Repo: web-dashboard$/m.test(x.j.content), x.out)
    writeFileSync(join(root2, 'PROJECT.md'), proj(`| web-dashboard | ${appDir} | .claude/tasks/ | web app |`))
    x = gen2('APP-13')
    check('handoff.mjs: without a Label [FE Dashboard] is not the repo web-dashboard: exit 1, the message names Label and --repo', x.code === 1 && /Label/.test(x.out) && /--repo/.test(x.out) && /web-dashboard/.test(x.out), x.out)
    x = gen2('APP-13', '--repo', 'web-dashboard')
    check('handoff.mjs: --repo names the repo of an FE ticket too', x.code === 0 && x.j?.appRepo === 'web-dashboard', x.out)
    writeFileSync(join(root2, 'PROJECT.md'), proj(`| web-dashboard | ${appDir} | .claude/tasks/ | web app | Web |`))
    x = gen2('APP-13', '--repo', 'web')
    check('handoff.mjs: --repo falls back to the Label when no repo has that name', x.code === 0 && x.j?.appRepo === 'web-dashboard', x.out)
    // a Label and a repo name that are the same word, in either row order: [FE <app>] takes the Label row, --repo the repo-name row
    const plainRow = `| dashboard | ${appDir} | .claude/tasks/ | old app |`
    const labelRow = `| web-dashboard | ${appDir} | .claude/tasks/ | web app | Dashboard |`
    for (const [order, rows] of [['repo row first', [plainRow, labelRow]], ['Label row first', [labelRow, plainRow]]]) {
      writeFileSync(join(root2, 'PROJECT.md'), proj(rows.join('\n')))
      x = gen2('APP-13')
      check(`handoff.mjs: [FE Dashboard] is the Label row, whatever the row order (${order})`, x.code === 0 && x.j?.appRepo === 'web-dashboard', x.out)
      x = gen2('APP-13', '--repo', 'dashboard')
      check(`handoff.mjs: --repo dashboard is the repo named dashboard, not the row whose Label is Dashboard (${order})`, x.code === 0 && x.j?.appRepo === 'dashboard', x.out)
    }
    // one Label on two rows: exit 1 naming both rows; the repo name still picks one
    writeFileSync(join(root2, 'PROJECT.md'), proj(`${labelRow}\n| web-admin | ${appDir} | .claude/tasks/ | admin | Dashboard |`))
    x = gen2('APP-13')
    check('handoff.mjs: a Label on two rows exits 1 and names both repos', x.code === 1 && /web-dashboard and web-admin/.test(x.out) && /Label/.test(x.out), x.out)
    x = gen2('APP-13', '--repo', 'web-admin')
    check('handoff.mjs: --repo with a repo name settles the duplicate Label', x.code === 0 && x.j?.appRepo === 'web-admin', x.out)
    // an App repos row without a Path: the handoff would land in the product repo
    writeFileSync(join(root2, 'PROJECT.md'), proj('| web-dashboard |  | .claude/tasks/ | web app | Dashboard |'))
    x = gen2('APP-13')
    check('handoff.mjs: an app row with an empty Path exits 1 naming the repo', x.code === 1 && /no Path for web-dashboard/.test(x.out), x.out)
  }

  // ids that survive into Decisions and Open questions are warnings (the script does not rewrite them); the open question asks for its H number
  {
    const statusPath = join(epicDir, 'STATUS.md')
    const original = readFileSync(statusPath, 'utf8')
    writeFileSync(statusPath, original.replace('| D1 | Which vendor first |', '| D1 | Which vendor first (P2, T3, see §4 of the brief, Q1 2027 is a date) |'))
    const x = gen('APP-12', '--repo', 'Dashboard')
    writeFileSync(statusPath, original)
    const w = x.j?.warnings ?? []
    check('handoff.mjs: an epic id, a § reference and "brief" in an assembled Decisions or Open questions line are warnings', ['Decisions', 'Open questions'].every((n) => ['P2', 'T3'].every((id) => w.some((m) => m.startsWith(`${n}: `) && m.includes(`${id} is an epic id`)))) && w.some((m) => /"§4" is a section reference/.test(m)) && w.some((m) => /ticket-brief-ref/.test(m)) && !w.some((m) => /Q1 is an epic id/.test(m)) && /P2, T3/.test(x.j.content), `${x.out}`)
    check('handoff.mjs: the Open questions line asks for the H number it blocks, and a warning says so', /^- Which vendor first.* — Dana — blocks H<n>: /m.test(bc) && w.some((m) => /blocks H<n>/.test(m)), `${bc}\n${w.join('\n')}`)
    writeFileSync(join(root, 'blocks.md'), bc.replace(/blocks H<n>:/g, 'blocks H1:'))
    r = lintFile(join(root, 'blocks.md'))
    check('product-lint handoff: "blocks H1: ..." in Open questions is accepted', r.code === 0, r.out)
    // a literal H<n> left in the file is a placeholder the lint rejects, once per line
    writeFileSync(join(root, 'blocks-left.md'), bc)
    r = lintFile(join(root, 'blocks-left.md'))
    check('product-lint handoff: "blocks H<n>:" left in Open questions is placeholder-left (exit 1)', r.code === 1 && /placeholder-left — H<n> is a placeholder/.test(r.out), r.out)
    // an enum-like token in a decision is a handoff warning (not a lint finding)
    writeFileSync(statusPath, original.replace('| D1 | Which vendor first |', '| D1 | Which vendor first (LEGACY_COMBINED_SLOT) |'))
    const en = gen('APP-12', '--repo', 'Dashboard')
    writeFileSync(statusPath, original)
    // m-5: the one STATE set: `decided <date>` with no author is not a state (the brief lint and the handoff agree)
    writeFileSync(statusPath, original.replace('decided 2026-11-10 Sam', 'decided 2026-11-10'))
    const noWho = gen('APP-13')
    writeFileSync(statusPath, original)
    check('handoff.mjs: "decided <date>" with no author is not a decision state (as in the brief lint): a warning, written as open', noWho.j?.warnings.some((m) => /D3 has the state "decided 2026-11-10"/.test(m)) && /^- Show the offer to all guests — yes, to all — Sam — open$/m.test(noWho.j?.content ?? ''), noWho.out)
    check('handoff.mjs: an enum-like token in a Decisions line is a warning', (en.j?.warnings ?? []).some((m) => /LEGACY_COMBINED_SLOT.*ticket-enum-token/.test(m)), en.out)
  }

  r = run(handoffBin, epicDir, 'APP-14')
  check('handoff.mjs: a [Design] ticket exits 1', r.code === 1 && /not a \[FE <app>\] or \[BE\] subtask/.test(r.out), r.out)
  r = run(handoffBin, epicDir, 'APP-99')
  check('handoff.mjs: a key that is not in the key map exits 1', r.code === 1 && /APP-99 is on no row/.test(r.out), r.out)
  r = run(handoffBin, epicDir)
  check('handoff.mjs: no key is a usage error, exit 2', r.code === 2, r.out)
  r = run(handoffBin, epicDir, 'APP-13')
  check('handoff.mjs: without --json it prints the text and the warnings apart', r.code === 0 && r.out.startsWith('<!-- product-handoff 1 -->') && /warning: criterion H2/.test(r.out), r.out)
  writeFileSync(join(appDir, '.claude/pipeline.config.md'), '# config\n- task_path: custom/tasks/   # local\n')
  check('handoff.mjs: task_path comes from the app repo\'s pipeline.config.md', gen('APP-13').j?.target === join(appDir, 'custom/tasks/APP-13/PRODUCT-HANDOFF.md'))
  // M-2: task_path is read as stage-pipeline reads it, one case per form; HOME is the fixture's, so `~` and `$HOME` land in the temp dir
  const home = join(root, 'home')
  const targetWith = (shared, local) => {
    writeFileSync(join(appDir, '.claude/pipeline.config.md'), shared)
    if (local === undefined) rmSync(join(appDir, '.claude/pipeline.config.local.md'), { force: true })
    else writeFileSync(join(appDir, '.claude/pipeline.config.local.md'), local)
    const r = spawnSync(process.execPath, [handoffBin, epicDir, 'APP-13', '--json'], { encoding: 'utf8', env: { ...process.env, HOME: home } })
    try { return JSON.parse(r.stdout).target } catch { return `${r.stdout}${r.stderr}` }
  }
  const tail = (dir) => join(dir, 'APP-13/PRODUCT-HANDOFF.md')
  for (const [form, line, dir] of [
    ['backticks', '- task_path: `.claude/tasks/`', join(appDir, '.claude/tasks')],
    ['backticks and a comment', '- task_path: `.claude/tasks/` — the shared folder', join(appDir, '.claude/tasks')],
    ['a <TICKET>/ tail', '- task_path: .claude/tasks/<TICKET>/', join(appDir, '.claude/tasks')],
    ['quotes', '- task_path: "work/tasks"', join(appDir, 'work/tasks')],
    ['~/', '- task_path: ~/tasks/', join(home, 'tasks')],
    ['$HOME/', '- task_path: `$HOME/tasks/<TICKET>/`', join(home, 'tasks')],
    ['an absolute path', `- task_path: ${join(root, 'abs-tasks')}`, join(root, 'abs-tasks')],
    ['a relative path with a comment mark', '- task_path: custom/tasks/   # local', join(appDir, 'custom/tasks')],
  ]) check(`handoff.mjs: task_path as ${form} is read like stage-pipeline reads it`, targetWith(`# config\n${line}\n`) === tail(dir), targetWith(`# config\n${line}\n`))
  check('handoff.mjs: pipeline.config.local.md goes over the shared config', targetWith('- task_path: shared/tasks/\n', '- task_path: local/tasks/\n') === tail(join(appDir, 'local/tasks')), targetWith('- task_path: shared/tasks/\n', '- task_path: local/tasks/\n'))
  check('handoff.mjs: a shared task_path is used when the local config has no such line', targetWith('- task_path: shared/tasks/\n', '# local\n') === tail(join(appDir, 'shared/tasks')))
  rmSync(join(appDir, '.claude/pipeline.config.local.md'), { force: true })
  rmSync(join(appDir, '.claude/pipeline.config.md'))
  mkdirSync(join(appDir, '.claude/tasks/APP-13'), { recursive: true })
  writeFileSync(join(appDir, '.claude/tasks/APP-13/PRODUCT-HANDOFF.md'), 'old\n')
  check('handoff.mjs: an existing handoff in the app repo is reported, not touched', gen('APP-13').j?.targetExists === true && readFileSync(join(appDir, '.claude/tasks/APP-13/PRODUCT-HANDOFF.md'), 'utf8') === 'old\n')

  // M-4: a repeated handoff keeps the H numbers of the copy in the epic; a dropped one is cancelled, a new one gets max + 1, a number is never reused
  mkdirSync(join(epicDir, 'handoff'), { recursive: true })
  writeFileSync(join(epicDir, 'handoff/APP-13.md'), [
    '<!-- product-handoff 1 -->', '# APP-13: Show availability on offers', '', '## Criteria',
    '- `H1` WHEN an old rule applies THEN an old result shows',
    '- `H2` WHEN a guest asks for slot swap THEN the offer shows only when a room is free',
    '- `H3` WHEN a guest opens the offers THEN the offer does not flash while loading (rewritten from the ticket)',
    '- `H5` [cancelled: replaced by H2]', '', '## Decisions', '- none', '',
  ].join('\n'))
  writeFileSync(join(epicDir, 'JIRA.md'), JIRA.replace('- The offer does not flash on load', '- The offer does not flash on load\n- WHEN the host edits an offer THEN the change is saved'))
  const again = gen('APP-13')
  const ac = (again.j?.content ?? '').split('## Decisions')[0]
  check('handoff.mjs: a repeated handoff keeps H2, carries H3 (the rewritten one, with its text, to be confirmed), cancels H1, keeps the cancelled H5 and numbers the new criterion H6', again.j?.copyExists === true && /^- `H1` \[cancelled: removed from the ticket\]$/m.test(ac) && /^- `H2` WHEN a guest asks for slot swap THEN the offer shows only when a room is free$/m.test(ac) && /^- `H3` WHEN a guest opens the offers THEN the offer does not flash while loading \(rewritten from the ticket\)$/m.test(ac) && /^- `H5` \[cancelled: replaced by H2\]$/m.test(ac) && /^- `H6` WHEN the host edits an offer THEN the change is saved$/m.test(ac) && !/`H4`/.test(ac) && again.j.rewritten.length === 0 && again.j.warnings.some((w) => /H3 keeps its number/.test(w)) && again.j.warnings.some((w) => /H1 is no longer in the ticket/.test(w)), again.out)
  const againFile = join(root, 'again.md')
  writeFileSync(againFile, (again.j?.content ?? '').replace(/blocks H<n>:/g, 'blocks H1:'))
  r = lintFile(againFile)
  check('product-lint handoff: the file of a repeated handoff (a cancelled H1, a kept H3) is clean', r.code === 0, r.out)
  writeFileSync(join(epicDir, 'JIRA.md'), JIRA)
  rmSync(join(epicDir, 'handoff'), { recursive: true })

  // M-1 and M-2: the ticket as a hand draft writes it (`<key> · Sub-task — [FE app]` heading, `Acceptance criteria:` with "*" bullets, a "Brief decisions" column, no Blocked by column)
  {
    const prod = join(root, 'draft-product')
    const e = join(prod, 'epics/draft-epic')
    mkdirSync(join(prod, 'app-dash/.claude'), { recursive: true })
    mkdirSync(e, { recursive: true })
    writeFileSync(join(prod, 'PROJECT.md'), fill(readFileSync(join(ROOT, 'templates/PROJECT.md'), 'utf8'), /^\| <dashboard> \|.*$/m, '| Dashboard | ./app-dash | — | web app |', 'PROJECT.md'))
    writeFileSync(join(e, 'STATUS.md'), ['# Loan renewal — product status', '', '## Open decisions', '| Id | Question | Recommendation | Owner | State |', '|---|---|---|---|---|', '| D7 | Late-return fee: waive or charge | waive the first one | Dana | open |', '| D2 | What counts as a renewal | the loan was extended before its due date | Dana | open |', ''].join('\n'))
    const draft = (mapHeader = 'Brief decisions', links = `Links ("blocks"): ${HK(314)}→${HK(315)}.`) => [
      `# Jira — loan renewal`, `Status: in Jira, epic ${HK(310)} · Updated: 2026-11-17`, '', links, '',
      `| # | Key | Type | Summary | Parent | ${mapHeader} |`, '|---|---|---|---|---|---|',
      `| E | ${HK(310)} | Epic | Loan renewal | — | all |`,
      `| T1.1 | ${HK(314)} | Sub-task | [BE] renewal handlers | ${HK(310)} | D2 |`,
      `| T1.2 | ${HK(315)} | Sub-task | [FE Dashboard] Show renewal status on loans | ${HK(310)} | D7 |`, '', '---', '',
      `## ${HK(310)} · Epic`, '', '**Why**', 'Members ask for it.', '**Open decisions**', '* None', '', '---', '',
      `## ${HK(314)} · Sub-task — [BE] renewal handlers`, '', '**Deliverables**', '1. The API contract.', '', 'Acceptance criteria:', '', '* WHEN a member renews THEN the loan has a new due date', '', '---', '',
      `## ${HK(315)} · Sub-task — [FE Dashboard] Show renewal status on loans`, '', 'Repo: `dashboard`.', 'Design: https://www.figma.com/design/abc/Draft?node-id=5-6', '',
      '* Shelf labels first.', '', 'Acceptance criteria:', '',
      '* WHEN a member holds a reserved copy THEN the loan page names the reservation.',
      '* WHEN a loan is listed THEN its row shows renewable or not renewable.',
      '* WHEN the librarian sets a loan period THEN the info text names the limit.',
      '* The loan list sorts exactly as it did before.', '', 'Out of scope:', '* Kiosk app.', '', '---', '',
    ].join('\n')
    writeFileSync(join(e, 'JIRA.md'), draft())
    const lintJira = run(lintBin, e, '--mode', 'jira')
    const g = (key, ...x) => {
      const out = run(handoffBin, e, key, '--json', ...x)
      try { return { ...out, j: JSON.parse(out.out.slice(out.out.indexOf('{'))) } } catch { return { ...out, j: null } }
    }
    const d = g(HK(315))
    const dc = d.j?.content ?? ''
    check('handoff.mjs: a hand-draft ticket keeps its four criteria ("Acceptance criteria:", "*" bullets), the one that is not WHEN/THEN is the marked placeholder', d.code === 0 && /^- `H1` WHEN a member holds a reserved copy THEN the loan page names the reservation\.$/m.test(dc) && /^- `H3` WHEN the librarian sets a loan period/m.test(dc) && /^- `H4` WHEN <condition> THEN <observable result> \(rewritten from the ticket\) <!-- src: [0-9a-f]{8} -->$/m.test(dc) && d.j.rewritten[0]?.original === 'The loan list sorts exactly as it did before.' && !d.j.warnings.some((w) => /no criterion lines/.test(w)), d.out)
    check('handoff.mjs: the "Brief decisions" column is the Decisions column: the open decision is a warning, a Decisions line and an Open questions line', d.j?.openDecisions[0]?.id === 'D7' && d.j.warnings.some((w) => /open decision the task depends on \(D7\)/.test(w)) && /^- Late-return fee: waive or charge — waive the first one — Dana — open$/m.test(dc) && /^## Open questions\n- Late-return fee: waive or charge — Dana — blocks/m.test(dc), d.out)
    check('handoff.mjs: no Blocked by column, a Links ("blocks") line: the blocker is read from it, its decisions and its contract come along', dc.includes(`Contract: the contract of "renewal handlers" (${HK(314)})`) && d.j.openDecisions.map((x) => x.id).join() === 'D7,D2' && d.j.warnings.some((w) => /\(D2, from T1\.1\)/.test(w)) && !d.j.warnings.some((w) => /no Blocked by/.test(w)), d.out)
    writeFileSync(join(e, 'JIRA.md'), draft('Brief decisions', 'Links ("blocks"): T1.1→T1.2 and E→T1.1.'))
    const byId = g(HK(315))
    check('handoff.mjs: a Links line in ids (T1.1→T1.2) is read like one in keys', /^Contract: the contract of "renewal handlers"/m.test(byId.j?.content ?? '') && byId.j.openDecisions.length === 2, byId.out)
    writeFileSync(join(e, 'JIRA.md'), draft('Brief decisions', `Links ("blocks"): ${HK(317)}→${HK(312)}, ${HK(314)}→${HK(320)} and ${HK(321)}.`))
    const noLink = g(HK(315))
    check('handoff.mjs: no Blocked by column and no Links line for this ticket: the Contract line is a placeholder and the warning names the missing contract and the blocker\'s decisions', /^Contract: <.*>$/m.test(noLink.j?.content ?? '') && noLink.j.warnings.some((w) => /no Blocked by column.*Contract line is a placeholder.*open decisions of that ticket are not carried/.test(w)) && !/^Contract: none$/m.test(noLink.j.content) && noLink.j.openDecisions.length === 1, noLink.out)
    writeFileSync(join(e, 'JIRA.md'), draft())
    check('handoff.mjs: an app path written relative in PROJECT.md is from the product repo, not from the working directory; no task_path anywhere is the default folder', d.j?.appPath === join(prod, 'app-dash') && d.j.target === join(prod, 'app-dash/.claude/tasks', HK(315), 'PRODUCT-HANDOFF.md') && d.j.taskPathSource === 'the default', d.out)
    // m-11: the [Design] lookup skips an epic parent; a [Design] ticket that blocks this one comes first
    {
      const FIG = 'https://www.figma.com/design/lib/Loans?node-id=9-9'
      const withDesign = (links) => draft('Brief decisions', links)
        .replace("Design: https://www.figma.com/design/abc/Draft?node-id=5-6\n", '')
        .replace(`| T1.2 | ${HK(315)} |`, `| T1.0 | ${HK(313)} | Sub-task | [Design] Loan screens | ${HK(310)} | — |\n| T1.2 | ${HK(315)} |`)
        .replace(`## ${HK(314)} · Sub-task`, `## ${HK(313)} · Sub-task — [Design] Loan screens\n\nMockups: ${FIG}\n\n---\n\n## ${HK(314)} · Sub-task`)
      writeFileSync(join(e, 'JIRA.md'), withDesign(`Links ("blocks"): ${HK(314)}→${HK(315)}.`))
      const epicParent = g(HK(315))
      check('handoff.mjs: a [Design] ticket under the epic (a per-team project) is not this screen\'s design: placeholder and warning, no foreign link', epicParent.code === 0 && /^Design source: <.*>$/m.test(epicParent.j?.content ?? '') && !epicParent.j.content.includes(FIG) && epicParent.j.warnings.some((w) => /no Figma link or prototype path/.test(w)), epicParent.out)
      writeFileSync(join(e, 'JIRA.md'), withDesign(`Links ("blocks"): ${HK(314)}→${HK(315)}; ${HK(313)}→${HK(315)}.`))
      const blocking = g(HK(315))
      check('handoff.mjs: a [Design] ticket that blocks the FE ticket (Links) is its design source, with the check-it warning', blocking.code === 0 && blocking.j.content.includes(`Design source: ${FIG}`) && blocking.j.warnings.some((w) => /comes from the \[Design\] subtask/.test(w)), blocking.out)
      writeFileSync(join(e, 'JIRA.md'), draft())
    }
    check('handoff.mjs: out of scope of the draft form ("Out of scope:" and "*" bullets) is read', /^## Out of scope\n- Kiosk app\.\n\n## Open questions$/m.test(dc) && !/^- ---$/m.test(dc), dc)
    // M-1: the criteria block is not ended by a sub-label; a criterion outside it is still one, with a warning
    const hCount = (res) => (res.j?.content.match(/^- `H\d+`/gm) ?? []).length
    const bodyOf315 = (edit) => {
      const t = draft()
      const at = t.indexOf(`## ${HK(315)}`)
      writeFileSync(join(e, 'JIRA.md'), t.slice(0, at) + edit(t.slice(at)))
      return g(HK(315))
    }
    const sub = bodyOf315((t) => t.replace('* WHEN a loan is listed', 'Requests table:\n* WHEN a loan is listed'))
    check('handoff.mjs: a sub-label inside the criteria list ("Requests table:") does not end it: all four criteria stay', hCount(sub) === 4 && /^- `H2` WHEN a loan is listed/m.test(sub.j.content) && /^- `H3` WHEN the librarian sets/m.test(sub.j.content), sub.out)
    const note = bodyOf315((t) => t.replace('* WHEN the librarian sets', 'Note: the due date comes from the loan record.\n* WHEN the librarian sets'))
    check('handoff.mjs: "Note:" inside the criteria list does not end it', hCount(note) === 4 && /^- `H3` WHEN the librarian sets/m.test(note.j.content), note.out)
    const inl = bodyOf315((t) => t.replace('Acceptance criteria:\n\n* WHEN a member holds a reserved copy THEN the loan page names the reservation.', 'Acceptance criteria: WHEN a member holds a reserved copy THEN the loan page names the reservation.'))
    check('handoff.mjs: a criterion on the label line ("Acceptance criteria: WHEN … THEN …") is one, with a warning', hCount(inl) === 4 && /^- `H1` WHEN a member holds a reserved copy THEN the loan page names the reservation\.$/m.test(inl.j.content) && inl.j.warnings.some((w) => /on the label line/.test(w)), inl.out)
    const loose = bodyOf315((t) => t.replace('Acceptance criteria:\n', 'Details:\n'))
    check('handoff.mjs: WHEN … THEN … bullets with no Criteria label are criteria, each named in a warning', hCount(loose) === 3 && loose.j.warnings.filter((w) => /outside the Criteria list/.test(w)).length === 3, loose.out)
    const bare = bodyOf315((t) => t.replace('* WHEN a loan is listed THEN its row shows renewable or not renewable.', 'WHEN a loan is listed THEN its row shows renewable or not renewable.'))
    check('handoff.mjs: a WHEN … THEN … line without a bullet inside the Criteria block is a criterion, with a warning', hCount(bare) === 4 && bare.j.warnings.some((w) => /has no list bullet/.test(w)), bare.out)
    const none = bodyOf315((t) => t.replace(/Acceptance criteria:[\s\S]*?Out of scope:/, 'Out of scope:'))
    check('handoff.mjs: a ticket with no criterion line at all gets one marked placeholder and the "no criterion lines" warning', hCount(none) === 1 && none.j.warnings.some((w) => /the ticket has no criterion lines/.test(w)), none.out)
    const dv = bodyOf315((t) => t.replace('* The loan list sorts exactly as it did before.\n', '* The loan list sorts exactly as it did before.\n\n---\n\n* WHEN a member opens the help THEN the renewal rule is explained.\n'))
    check('handoff.mjs: a "---" line ends the Criteria block: a WHEN … THEN … bullet after it is a criterion by the outside rule, with the warning', hCount(dv) === 5 && dv.j.warnings.some((w) => /outside the Criteria list.*renewal rule is explained/.test(w)), dv.out)
    const prose = bodyOf315((t) => t.replace('* Kiosk app.', '* Kiosk app.\nSee the kiosk ticket for the rest.'))
    check('handoff.mjs: a prose line in the Out of scope block is an item too (m-2), and it is not warned as missing', /^## Out of scope\n- Kiosk app\.\n- See the kiosk ticket for the rest\.\n\n## Open questions$/m.test(prose.j?.content ?? '') && !prose.j.warnings.some((w) => /names nothing out of scope/.test(w)), prose.out)
    const proseOnly = bodyOf315((t) => t.replace('Out of scope:\n* Kiosk app.', '**Out of scope**\nThe kiosk app and fines stay as they are.'))
    check('handoff.mjs: an Out of scope block written as prose under the label is carried, no "names nothing" warning', /^## Out of scope\n- The kiosk app and fines stay as they are\.\n/m.test(proseOnly.j?.content ?? '') && !proseOnly.j.warnings.some((w) => /names nothing out of scope/.test(w)), proseOnly.out)
    const noBlock = bodyOf315((t) => t.replace('Out of scope:\n* Kiosk app.\n', ''))
    check('handoff.mjs: a ticket with no Out of scope block gets "- none" and the warning', /^## Out of scope\n- none\n/m.test(noBlock.j?.content ?? '') && noBlock.j.warnings.some((w) => /names nothing out of scope/.test(w)), noBlock.out)
    const nn = bodyOf315((t) => t.replace('Out of scope:\n* Kiosk app.', '**Out of scope:** None.'))
    check('handoff.mjs: "Out of scope: None." gives "- none", not a "None." item, and no warning: the ticket says it', /^## Out of scope\n- none\n/m.test(nn.j?.content ?? '') && !nn.j.warnings.some((w) => /names nothing out of scope/.test(w)), nn.out)
    writeFileSync(join(e, 'JIRA.md'), draft())

    // m-1: a rewritten criterion is matched by the hash of its ticket line; the position guess is for one pair only
    mkdirSync(join(e, 'handoff'), { recursive: true })
    const copyOf = join(e, 'handoff', `${HK(315)}.md`)
    const df0 = join(root, 'again-draft.md')
    const lintTxt = (txt) => { writeFileSync(df0, txt.replace(/blocks H<n>:/g, 'blocks H1:')); return run(lintBin, e, '--mode', 'handoff', '--file', df0) }
    const edited = dc.replace(/^- `H4` WHEN <condition> THEN <observable result> \(rewritten from the ticket\)/m, '- `H4` WHEN a member opens any of the seven shelf views THEN the list looks as it did before')
    writeFileSync(copyOf, edited)
    const same4 = g(HK(315))
    check('handoff.mjs: the user\'s text of a rewritten criterion stays with its number by the hash of the ticket line; it is listed in carried and needs no warning', /^- `H4` WHEN a member opens any of the seven shelf views THEN the list looks as it did before <!-- src: [0-9a-f]{8} -->$/m.test(same4.j?.content ?? '') && same4.j.carried.length === 1 && same4.j.carried[0].h === 'H4' && same4.j.carried[0].by === 'hash' && same4.j.rewritten.length === 0 && !same4.j.warnings.some((w) => /keeps its number/.test(w)), same4.out)
    r = lintTxt(same4.j?.content ?? '')
    check('product-lint handoff: the src hash comment on an H line is invisible to the lint (plan-check reads only the H id at the line start)', r.code === 0 && /^- `H4` .* <!-- src: [0-9a-f]{8} -->$/m.test(same4.j?.content ?? ''), r.out)
    const swapped = bodyOf315((t) => t.replace('* The loan list sorts exactly as it did before.', '* Every shelf view keeps its layout.'))
    check('handoff.mjs: a rewritten criterion whose ticket line changed, one on each side: kept by position, listed in carried, with the warning that names both texts', swapped.j?.carried[0]?.by === 'position' && swapped.j.carried[0].ticket === 'Every shelf view keeps its layout.' && swapped.j.warnings.some((w) => /H4 keeps its number.*Every shelf view keeps its layout/.test(w)), swapped.out)
    const twice = bodyOf315((t) => t.replace('* The loan list sorts exactly as it did before.', '* Members of other branches see no change.\n* The loan list sorts exactly as it did before.'))
    check('handoff.mjs: a new rewritten criterion added before the old one: the old keeps H4 by its hash, the new one is H5 (no position swap)', /^- `H4` WHEN a member opens any of the seven shelf views/m.test(twice.j?.content ?? '') && /^- `H5` WHEN <condition> THEN <observable result> \(rewritten from the ticket\) <!-- src: [0-9a-f]{8} -->$/m.test(twice.j.content) && twice.j.carried.length === 1 && twice.j.carried[0].by === 'hash', twice.out)
    writeFileSync(copyOf, edited.replace(/ <!-- src: [0-9a-f]+ -->/, ' (rewritten from the ticket)'))
    const two = bodyOf315((t) => t.replace('* The loan list sorts exactly as it did before.', '* Members of other branches see no change.\n* The loan list sorts exactly as it did before.'))
    check('handoff.mjs: with no hash and two rewritten lines against one marked criterion there is no position guess: new numbers, a warning, the old one cancelled', /^- `H4` \[cancelled: removed from the ticket\]$/m.test(two.j?.content ?? '') && /^- `H5` WHEN <condition>/m.test(two.j.content) && /^- `H6` WHEN <condition>/m.test(two.j.content) && two.j.carried.length === 0 && two.j.warnings.some((w) => /could not be matched to H4/.test(w)), two.out)
    writeFileSync(copyOf, dc.replace(/ <!-- src: [0-9a-f]+ -->/, ''))
    const gone = bodyOf315((t) => t.replace('* The loan list sorts exactly as it did before.\n', ''))
    check('handoff.mjs: a rewritten criterion that left the ticket is cancelled; its number is not reused', /^- `H4` \[cancelled: removed from the ticket\]$/m.test(gone.j?.content ?? '') && gone.j.carried.length === 0, gone.out)
    // the same names and the old number come from the app repo's file when there is no copy in the epic
    rmSync(copyOf)
    const targetFile = join(prod, 'app-dash/.claude/tasks', HK(315), 'PRODUCT-HANDOFF.md')
    mkdirSync(dirname(targetFile), { recursive: true })
    writeFileSync(targetFile, ['<!-- product-handoff 1 -->', `# ${HK(315)}: x`, '', '## Criteria', '- `H7` when a MEMBER holds a reserved copy then the loan page names the reservation. (rewritten from the ticket)', '', '## Decisions', '- none', ''].join('\n'))
    const fromTarget = g(HK(315))
    check('handoff.mjs: with no copy in the epic the H numbers come from the file in the app repo; texts are compared without case and without the "rewritten" mark', /^- `H7` when a MEMBER holds a reserved copy then the loan page names the reservation\. \(rewritten from the ticket\)$/m.test(fromTarget.j?.content ?? '') && /^- `H8` WHEN a loan is listed/m.test(fromTarget.j.content), fromTarget.out)
    writeFileSync(copyOf, dc.replace('## Criteria', '### Criteria').replace(/`H(\d)`/g, '`H7$1`'))
    const lvl = g(HK(315))
    check('handoff.mjs: a "### Criteria" in the copy is not the section: its numbers are not read', /^- `H1` WHEN a member holds/m.test(lvl.j?.content ?? '') && !/H7/.test(lvl.j.content) && !/H7\d/.test(lvl.j.content), lvl.out)
    rmSync(join(e, 'handoff'), { recursive: true })
    rmSync(join(prod, 'app-dash/.claude/tasks'), { recursive: true })

    // m-4: the PROJECT.md column is for an app repo with no pipeline config at all
    const projectMd = readFileSync(join(prod, 'PROJECT.md'), 'utf8')
    writeFileSync(join(prod, 'PROJECT.md'), fill(projectMd, /^\| Dashboard \|.*$/m, '| Dashboard | ./app-dash | docs/tasks/ | web app |', 'PROJECT.md'))
    const col0 = g(HK(315))
    check('handoff.mjs: no pipeline config in the app repo: the PROJECT.md task_path column is the folder', col0.j?.target === join(prod, 'app-dash/docs/tasks', HK(315), 'PRODUCT-HANDOFF.md') && col0.j.taskPathSource === 'the PROJECT.md task_path column', col0.out)
    writeFileSync(join(prod, 'app-dash/.claude/pipeline.config.md'), '# config\n- stack: next\n')
    const col1 = g(HK(315))
    check('handoff.mjs: a pipeline config without a task_path line is the default .claude/tasks, as stage-pipeline reads it; the column is not used', col1.j?.target === join(prod, 'app-dash/.claude/tasks', HK(315), 'PRODUCT-HANDOFF.md') && col1.j.taskPathSource === 'the default', col1.out)
    writeFileSync(join(prod, 'app-dash/.claude/pipeline.config.md'), '# config\n- task_path:   \n')
    const col2 = g(HK(315))
    check('handoff.mjs: an empty task_path value is the default .claude/tasks', col2.j?.target === join(prod, 'app-dash/.claude/tasks', HK(315), 'PRODUCT-HANDOFF.md'), col2.out)
    rmSync(join(prod, 'app-dash/.claude/pipeline.config.md'))
    writeFileSync(join(prod, 'PROJECT.md'), projectMd)

    // m-3: an H line with no bullet is read by plan-check and checked by nothing else: a finding
    const nb = join(root, 'nobullet.md')
    const okDraft = dc.replace(/^- `H4`.*$/m, '- `H4` WHEN a member opens a shelf view THEN it looks as before').replace(/blocks H<n>:/g, 'blocks H1:')
    writeFileSync(nb, okDraft)
    r = run(lintBin, e, '--mode', 'handoff', '--file', nb)
    check('product-lint handoff: the draft ticket\'s file with H4 written is clean', r.code === 0, r.out)
    for (const [form, from, to] of [['`H4` text', '- `H4`', '`H4`'], ['H4: text', '- `H4`', 'H4:']]) {
      writeFileSync(nb, okDraft.replace(from, to))
      r = run(lintBin, e, '--mode', 'handoff', '--file', nb)
      check(`product-lint handoff: a criterion as "${form}" with no bullet is a handoff-criterion finding`, r.code === 1 && /handoff-criterion — a criterion is a `-` or `\*` bullet/.test(r.out), r.out)
    }
    // From: on a line of a section is not the header's From: line
    writeFileSync(nb, okDraft.replace('## Out of scope\n', '## Out of scope\nFrom: see D3 and the brief\n'))
    r = run(lintBin, e, '--mode', 'handoff', '--file', nb)
    check('product-lint handoff: a "From:" line without a bullet below the header gets every rule', r.code === 1 && / — ticket-epic-id — D3/.test(r.out) && / — ticket-brief-ref/.test(r.out), r.out)
    const df = join(root, 'draft.md')
    writeFileSync(df, dc)
    r = run(lintBin, e, '--mode', 'handoff', '--file', df)
    check('product-lint handoff: the draft ticket\'s file is not clean until the rewritten criterion and the contract are written', r.code === 1 && /placeholder-left/.test(r.out), r.out)
    writeFileSync(join(e, 'JIRA.md'), draft('Notes'))
    const n = g(HK(315))
    check('handoff.mjs: a key map without a Decisions column gives a warning and a placeholder line the lint rejects, not "none"', n.code === 0 && n.j.warnings.some((w) => /no Decisions column/.test(w)) && /^- <question> — <decision or recommendation> — <who decides> — open$/m.test(n.j.content) && !/^## Decisions\n- none/m.test(n.j.content), n.out)
    writeFileSync(df, n.j?.content ?? '')
    r = run(lintBin, e, '--mode', 'handoff', '--file', df)
    check('product-lint handoff: that placeholder line is a placeholder-left finding', /placeholder-left — <question>/.test(r.out), r.out)
    r = run(handoffBin, e, '../../escape')
    check('handoff.mjs: a key that is not a Jira key (it would become a path) exits 2', r.code === 2 && /not a Jira key/.test(r.out), r.out)
    r = run(handoffBin, e, 'https://jira.example/browse/' + HK(315))
    check('handoff.mjs: a pasted URL instead of the key exits 2', r.code === 2, r.out)
    check('product-lint jira: the hand-draft shape lints clean (what the handoff reads is what the lint accepts)', lintJira.code === 0, lintJira.out)
    // the app path through ~ : HOME is the fixture's
    writeFileSync(join(prod, 'PROJECT.md'), fill(readFileSync(join(prod, 'PROJECT.md'), 'utf8'), /^\| Dashboard \|.*$/m, '| Dashboard | ~/apps/dash | — | web app |', 'PROJECT.md'))
    const hm = spawnSync(process.execPath, [handoffBin, e, HK(315), '--json'], { encoding: 'utf8', env: { ...process.env, HOME: join(root, 'home') } })
    check('handoff.mjs: an app path "~/..." is expanded like doctor expands it', JSON.parse(hm.stdout).appPath === join(root, 'home/apps/dash'), hm.stdout + hm.stderr)
    writeFileSync(join(prod, 'PROJECT.md'), fill(readFileSync(join(prod, 'PROJECT.md'), 'utf8'), /^\| Dashboard \|.*$/m, '| Dashboard | ~bob/dash | — | web app |', 'PROJECT.md'))
    const bob = run(handoffBin, e, HK(315), '--json')
    check('handoff.mjs: "~bob/..." is not a home path (one rule, as doctor: "~" and "~/" only)', JSON.parse(bob.out.slice(bob.out.indexOf('{'))).appPath === join(prod, '~bob/dash'), bob.out)
  }

  // the lint: the helper's text with the rewritten criterion filled in is clean; unfilled it is not
  const fixed = c.replace('WHEN <condition> THEN <observable result> (rewritten from the ticket)', 'WHEN a guest opens the offers THEN the offer does not flash while loading (rewritten from the ticket)').replace(/blocks H<n>:/g, 'blocks H1:')
  const ok = join(root, 'ok.md')
  writeFileSync(ok, fixed)
  r = lintFile(ok)
  check('product-lint handoff: a handoff assembled from the template and the fixture is clean', r.code === 0 && !/ — /.test(r.out), r.out)
  writeFileSync(ok, c)
  r = lintFile(ok)
  check('product-lint handoff: the unfilled rewritten criterion is a placeholder finding', r.code === 1 && /placeholder-left/.test(r.out), r.out)
  mkdirSync(join(epicDir, 'handoff'), { recursive: true })
  writeFileSync(join(epicDir, 'handoff/APP-13.md'), fixed)
  r = run(lintBin, epicDir, '--mode', 'handoff')
  check('product-lint handoff: without --file it reads every file of handoff/', r.code === 0, r.out)

  // AC-6.2: D3 in the text, no marker, a criterion without THEN: three findings, exit 1
  const lineOf = (text, re) => text.split('\n').findIndex((l) => re.test(l)) + 1
  const planted = fixed.split('\n').slice(1).join('\n').replace('## Out of scope\n', '## Out of scope\n- What D3 decided is not repeated here\n').replace('WHEN a guest asks for slot swap THEN the offer shows only when a room is free', 'WHEN a guest asks for slot swap the offer shows')
  const bad = join(root, 'bad.md')
  writeFileSync(bad, planted)
  r = lintFile(bad)
  const hits = r.out.split('\n').filter((l) => / — .* — /.test(l))
  check('product-lint handoff: D3 in the text, no marker, a criterion without THEN give three findings, exit 1', r.code === 1 && hits.length === 3 && hits.some((l) => /^bad\.md:1 — handoff-marker|— handoff-marker —/.test(l)) && hits.some((l) => l.includes(`:${lineOf(planted, /What D3 decided/)} — ticket-epic-id — D3`)) && hits.some((l) => l.includes(`:${lineOf(planted, /the offer shows$/)} — handoff-criterion — H1`)), r.out)
  const variants = [
    ['an unknown version in the marker', (t) => t.replace('product-handoff 1', 'product-handoff 2'), /handoff-marker — unknown handoff version "2"/],
    ['a missing header field', (t) => t.replace(/^Design source:.*\n/m, ''), /handoff-field — the header has no "Design source:" line/],
    ['an empty header field', (t) => t.replace(/^Contract:.*$/m, 'Contract:'), /handoff-field — "Contract:" is empty/],
    ['a Type with a placeholder app', (t) => t.replace('Type: [FE Dashboard]', 'Type: [FE <app>]'), /handoff-field — Type is/],
    ['a missing section', (t) => t.replace(/## Open questions[\s\S]*$/, ''), /handoff-section — no "## Open questions" section/],
    ['a criterion without its H id', (t) => t.replace(/^- `H1` /m, '- '), /handoff-criterion — a criterion starts with its own id/],
    ['a reused H number', (t) => t.replace(/^- `H2` /m, '- `H1` '), /handoff-criterion — H1 is also on line/],
    ['a decision without a state', (t) => t.replace(/ — decided 2026-11-10$/m, ''), /handoff-decision — a decision ends with its state/],
    ['a section reference', (t) => t.replace('## Out of scope\n', '## Out of scope\n- Everything in §9\n'), /ticket-section-ref/],
    ['a path into the product repo', (t) => t.replace('## Out of scope\n', '## Out of scope\n- See data/Q1-vendor-share.md\n'), /ticket-epic-file/],
    ['a placeholder of the handoff template (not of the Jira one) left in a section', (t) => t.replace(/## Open questions\n.*$/m, '## Open questions\n- Which vendor first — <who can answer> — the offer'), /placeholder-left — <who can answer>/],
    ['a template placeholder left in the From line', (t) => t.replace(/^From:.*$/m, 'From: <product repo> · epics/early'), /placeholder-left — <product repo>/],
  ]
  for (const [name, fn, re] of variants) {
    writeFileSync(bad, fn(fixed))
    r = lintFile(bad)
    check(`product-lint handoff: ${name} is a finding`, r.code === 1 && re.test(r.out), r.out)
  }
  writeFileSync(bad, fixed.replace(/^From:.*$/m, 'From: acme-brief · epics/early'))
  r = lintFile(bad)
  check('product-lint handoff: the From line may name the product repo and the epic folder, even with the word "brief" in the slug', r.code === 0, r.out)
  writeFileSync(bad, fixed.replace(/^From:.*$/m, 'From: acme-product · epics/early (brief §9, F1, D3)'))
  r = lintFile(bad)
  check('product-lint handoff: on the From line epic ids and section references are still findings; the word "brief" is not', r.code === 1 && / — ticket-epic-id — F1/.test(r.out) && / — ticket-epic-id — D3/.test(r.out) && / — ticket-section-ref — "§9"/.test(r.out) && !/ticket-brief-ref/.test(r.out), r.out)
  writeFileSync(bad, fixed.replace('## Out of scope\n', '## Out of scope\n- From: see D3 and the brief\n'))
  r = lintFile(bad)
  check('product-lint handoff: a line that only starts with "From:" below the header gets every rule', r.code === 1 && / — ticket-epic-id — D3/.test(r.out) && / — ticket-brief-ref/.test(r.out), r.out)
  writeFileSync(bad, fixed.replace(/^From:.*$/m, 'From: acme-product'))
  r = lintFile(bad)
  check('product-lint handoff: From without " · " (the product repo and the epic folder) is a finding', r.code === 1 && /handoff-field — From is/.test(r.out), r.out)
  writeFileSync(bad, fixed.replace(/^# APP-13:/m, '# Show availability:'))
  r = lintFile(bad)
  check('product-lint handoff: a title without the Jira key first is handoff-title', r.code === 1 && /handoff-title/.test(r.out), r.out)
  writeFileSync(bad, fixed.replace(/## Criteria\n(- .*\n)+/, '## Criteria\n'))
  r = lintFile(bad)
  check('product-lint handoff: an empty Criteria section is a finding', r.code === 1 && /handoff-criterion — the Criteria section has no criterion/.test(r.out), r.out)
  writeFileSync(bad, fixed.replace('## Criteria', '### Criteria'))
  r = lintFile(bad)
  check('product-lint handoff: "### Criteria" is not the section plan-check reads: a finding', r.code === 1 && /handoff-section — no "## Criteria" section/.test(r.out), r.out)
  writeFileSync(bad, fixed.replace(/^- `H(\d)` /gm, '$1. `H$1` '))
  r = lintFile(bad)
  check('product-lint handoff: a numbered list of criteria is a finding (plan-check reads "-" and "*" bullets only)', r.code === 1 && /a criterion is a `-` or `\*` bullet/.test(r.out), r.out)
  writeFileSync(bad, fixed.replace(/^- `H1` /m, '* `H1` '))
  r = lintFile(bad)
  check('product-lint handoff: a "*" bullet for a criterion is read like "-"', r.code === 0, r.out)
  writeFileSync(bad, fixed.replace('WHEN a guest asks for slot swap THEN the offer shows only when a room is free', '[cancelled: dropped with the vendor change]'))
  r = lintFile(bad)
  check('product-lint handoff: a cancelled criterion needs no THEN', r.code === 0, r.out)
  rmSync(join(epicDir, 'handoff'), { recursive: true })
  r = run(lintBin, epicDir, '--mode', 'handoff')
  check('product-lint handoff: no handoff files and no --file is a finding', r.code === 1 && /handoff-missing/.test(r.out), r.out)
  r = run(lintBin, epicDir, '--mode', 'handoff', '--file', join(root, 'missing.md'))
  check('product-lint handoff: a --file that is not there exits 2', r.code === 2, r.out)

  // the contract's id table is the one source of the banned ids in handoff mode too
  const copyDir = copy()
  edit(copyDir, 'references/product-repo.md', (s) => s.replace('| `T<n>` | a task of the split |', '| `X<n>` | an invented id | JIRA.md | JIRA.md |\n| `T<n>` | a task of the split |'))
  writeFileSync(bad, fixed.replace('## Out of scope\n', '## Out of scope\n- Waits for X5\n'))
  r = run(join(copyDir, 'scripts/product-lint.mjs'), epicDir, '--mode', 'handoff', '--file', bad)
  check('product-lint handoff: the banned ids come from the contract table (an X<n> row added there makes X5 a finding)', r.code === 1 && /ticket-epic-id — X5/.test(r.out), r.out)
  edit(copyDir, 'references/product-repo.md', () => 'no table here\n')
  r = run(join(copyDir, 'scripts/product-lint.mjs'), epicDir, '--mode', 'handoff', '--file', bad)
  check('product-lint handoff: an unreadable id table exits 2', r.code === 2, r.out)
  rmSync(copyDir, { recursive: true, force: true })

  // AC-6.4: the template carries the spec's marker, header fields and section names
  // the spec lives in stage-pipeline, another repo: STAGE_PIPELINE_SPEC points at its references/product-handoff.md; without it the pinned list below is the reference
  const SPEC = process.env.STAGE_PIPELINE_SPEC ?? ''
  // pinned from the spec of version 1, used when the spec is not on this machine (stage-pipeline lives in another repo)
  const pinned = { marker: '<!-- product-handoff 1 -->', fields: ['Type', 'App/Repo', 'From', 'Design source', 'Contract'], sections: ['Criteria', 'Decisions', 'Out of scope', 'Open questions'] }
  const shapeOf = (text) => {
    const raw = text.split('\n')
    const fence = raw.findIndex((l) => /^```markdown/.test(l))
    const lines = fence >= 0 ? raw.slice(fence + 1, raw.indexOf('```', fence + 1)) : raw
    const first = lines.findIndex((l) => /^##\s/.test(l))
    return { marker: raw[0].trim(), fields: lines.filter((l, i) => /^[A-Z][\w/ ]*:/.test(l) && (first < 0 || i < first)).map((l) => l.split(':')[0]) }
  }
  const tpl = readFileSync(join(ROOT, 'templates/PRODUCT-HANDOFF.md'), 'utf8')
  const tplShape = { marker: tpl.split('\n')[0].trim(), fields: shapeOf(tpl).fields, sections: tpl.split('\n').flatMap((l) => l.match(/^##\s+(.+?)\s*$/)?.[1] ?? []) }
  check('templates: STAGE_PIPELINE_SPEC, when set, points at a file (a missing path would silently fall back to the pinned list)', !SPEC || existsSync(SPEC), `STAGE_PIPELINE_SPEC=${SPEC} is not a file`)
  const spec = SPEC && existsSync(SPEC) ? readFileSync(SPEC, 'utf8') : null
  const want = spec
    ? { marker: spec.split('\n')[0].trim(), fields: shapeOf(spec).fields, sections: [...spec.matchAll(/^### `## ([^`]+)`$/gm)].map((m) => m[1]) }
    : pinned
  check(`templates: PRODUCT-HANDOFF has the marker, header fields and section names of the stage-pipeline spec (${spec ? `source: the spec file ${SPEC}` : 'source: the pinned list, STAGE_PIPELINE_SPEC is not set or not a file'})`, JSON.stringify(tplShape) === JSON.stringify(want) && want.fields.length === 5 && want.sections.length === 4, `${JSON.stringify(tplShape)}\n${JSON.stringify(want)}`)
  check('templates: the pinned list equals the template too', JSON.stringify(tplShape) === JSON.stringify(pinned), JSON.stringify(tplShape))
  rmSync(root, { recursive: true, force: true })
}

// templates and skills of decisions, split and Jira
{
  const t = (name) => readFileSync(join(ROOT, name), 'utf8')
  const msg = t('templates/message.md')
  check('templates: message has the reader, the numbered decisions with a cost and the unnumbered open questions', ['To:', 'Group:', '## Decisions', 'I suggest', 'It costs', '## Open questions'].every((x) => msg.includes(x)))
  const jira = t('templates/JIRA.md')
  check('templates: JIRA has the key map columns, an epic with open decisions, a [BE] with the contract first and criteria', ['| T | Key | Type | Summary | Parent | Blocked by | Decisions | Order |', '**Open decisions**', '[BE]', '[FE <app>]', '1. The API contract', '- WHEN'].every((x) => jira.includes(x)))
  const decisions = t('skills/product-decisions/SKILL.md')
  check('product-decisions: grouping confirmed, recommendation and cost per item, open questions apart, text check, draft outside the epic, decided without unsigning', ['grouping', 'I suggest', 'It costs', 'unnumbered', 'human-text-check', 'outside the epic', 'decided <date> <who>', 'do not change `Updated:`', 'chosen; recommended:', '--mode text'].every((x) => decisions.includes(x)))
  const split = t('skills/product-split/SKILL.md')
  check('product-split: data-request warning, [BE]/[FE <app>]/[Design], WHEN/THEN, the contract first, ids written back, the jira lint', ['Status: open', '[BE]', '[FE <app>]', '[Design]', 'WHEN <condition> THEN', 'API contract', '| Id | Task | Key |', '--mode jira', 'or with that key at the start of its heading'].every((x) => split.includes(x)))
  const pj = t('skills/product-jira/SKILL.md')
  check('product-jira: manual by default, the site and the project list before the connector, the first link read back, the drift fields, no guess from commits', ['Manual is the default', 'equals the PROJECT.md Jira site', 'project list', 'matched by name', 'read both issues back', 'summary', 'type', 'parent', 'links', 'text', '--mode text --file', '<key> — text', 'never by commit prefixes'].every((x) => pj.includes(x)))
  const ph = t('skills/product-handoff/SKILL.md')
  check('product-handoff: found by key, WHEN/THEN rewrites shown, open decision warned before writing, the lint, the user\'s yes, never overwrite, STATUS.md entry, the next commands', ['key → key map row → heading', 'rewritten from the ticket', 'Warn before writing', 'Open questions', '--mode handoff', 'only after the user\'s yes', 'never overwrite', '<KEY> → <app repo> <date>', '/stage-pipeline:feature-checker <KEY>', '/stage-pipeline:stage-plan <KEY>', 'stage 1 is the contract', 'task_path'].every((x) => ph.includes(x)))
  for (const name of ['product-decisions', 'product-split', 'product-jira', 'product-handoff']) {
    check(`${name}: the description ends with RU triggers`, / RU triggers — «[^»]+»(, «[^»]+»)*\n/.test(t(`skills/${name}/SKILL.md`).split('---')[1] + '\n'))
  }
}

// agent: reads and writes its report only, never edits
{
  const agent = readFileSync(join(ROOT, 'agents/brief-review.md'), 'utf8')
  const tools = agent.match(/^tools:\s*(.*)$/m)?.[1] ?? ''
  check('brief-review: model sonnet, tools Read Grep Glob Bash Write and no Edit', /^model: sonnet$/m.test(agent) && tools.split(',').map((t) => t.trim()).join(',') === 'Read,Grep,Glob,Bash,Write' && !/Edit/.test(tools), tools)
  const skill = readFileSync(join(ROOT, 'skills/product-brief/SKILL.md'), 'utf8')
  const checks = skill.split('## The checks (the agent\'s methodology)')[1] ?? ''
  check('brief-review: the methodology holds the six checks, the no-edit rule and the report format', ['without a source', 'concentration', 'manual', 'UI', 'cost', 'pending data', 'Findings: critical', 'Could not verify'].every((w) => checks.includes(w)) && /never edits? the brief|change no file except the report/i.test(skill + agent), checks.slice(0, 200))
}

// shipped templates carry the fields the skills rely on
{
  const t = (name) => readFileSync(join(ROOT, 'templates', name), 'utf8')
  const req = t('data-request.md')
  check('templates: data-request has question, why, query, where it runs, status', ['## Question', '## Why it matters', '## Query', '## Where it runs', 'Status: open'].every((h) => req.includes(h)))
  check('templates: capability-matrix has the confirm with vendor status', /`confirm with vendor`/.test(t('capability-matrix.md')) && /confirmed <source>/.test(t('capability-matrix.md')))
  check('templates: INTAKE marks repos as assumptions', /\| assumption \|/.test(t('INTAKE.md')))
  const brief = t('BRIEF.md')
  const sections = ['Summary', 'What exists', 'Problems', 'Users', 'Goals and metrics', 'Scope', 'How it works', 'Decisions', 'Research', 'Epic and tasks', 'Sequencing', 'Risks', 'Open questions and data requests']
  check('templates: BRIEF has a place for each of the 13 sections of a hand-written brief, in order', sections.map((h) => brief.indexOf(`\n## ${h}\n`)).every((i, k, a) => i >= 0 && (k === 0 || i > a[k - 1])))
  check('templates: BRIEF has the header fields and the decision columns with cost and state', ['Status:', 'Language:', 'Updated:', 'Signed off:', '| Goal | Metric | Baseline | Target |', '| Risk | Impact | Mitigation |', '| Id | Question | Options | Recommendation | Cost | Owner | State |', '### v1', '### Later', '### Out'].every((x) => brief.includes(x)))
  // live-run fixes: the template and the skills carry the rules the scripts rely on
  const skillText = (n) => readFileSync(join(ROOT, 'skills', n, 'SKILL.md'), 'utf8')
  check('templates: PROJECT has an optional Label column in App repos', /^\| Repo \| Path \| task_path \| What it is \| Label \|$/m.test(t('PROJECT.md')))
  check('skills: product adopts with the template states only ("by reading" in Notes, Signed off —) and warns, not errors, on a done-by-reading phase without a date', /`done` with "by reading"/.test(skillText('product')) && /Signed off left `—`/.test(skillText('product')) && /not an error/.test(skillText('product')) && !/done-by-reading/.test(skillText('product')) && /by reading/.test(t('STATUS.md')))
  check('skills: product-handoff closes the phase for the round and lists "later: <keys>"; product names /product-handoff again for a ticket with no handoff and no "later"', /for this round/.test(skillText('product-handoff')) && /later: <keys>/.test(skillText('product-handoff')) && /later: <keys>/.test(skillText('product')) && /`--repo` works for an `\[FE\]` ticket too/.test(skillText('product-handoff')))
  // the final-checks round: the rules the scripts cannot hold sit in one place each and the skills cite them
  const refText = (n) => readFileSync(join(ROOT, 'references', n), 'utf8')
  const contract = refText('product-repo.md')
  check('contract: one definition of "the brief is signed" (a date, Updated not later, a done-by-reading brief with no date is not signed) that /product, decisions and split cite', /\*\*The brief is signed\*\* when/.test(contract) && /Signed off `—`.*is not signed/.test(contract) && ['product', 'product-decisions', 'product-split'].every((n) => /contract's definition/.test(skillText(n))) && !/`Updated:` not later than `Signed off:`/.test(skillText('product-decisions') + skillText('product-split')))
  check('skills: /product defines "a phase out of order" so Decisions `open` with "sent" (split goes on while stakeholders answer) is not a warning', /a phase out of order \(a later phase `done` while an earlier one is `not started`.*unless that is Decisions `open` with `sent <date>`/.test(skillText('product')))
  check('S-2: the contract, the PROJECT template, /product (intake of the route and adoption), discovery and brief-review carry the no-secrets rule; the data route names no password', /No credential in any file of the product repo/.test(contract) && /never its password/.test(t('PROJECT.md')) && /with no password or token in it/.test(t('PROJECT.md')) && /connection string, password or token in it is masked/.test(skillText('product')) && /never a password, token or URI with a password/.test(skillText('product')) && /credentials and for row-level data first/.test(skillText('product-discovery')) && /data\/rows\//.test(contract) && /quoted without secrets/.test(readFileSync(join(ROOT, 'agents/brief-review.md'), 'utf8')) && /<set>/.test(readFileSync(join(ROOT, 'agents/brief-review.md'), 'utf8')))
  check('S-1: the doctor, discovery and research.md send the clone through scripts/clone.mjs with --yes after the shown command, and no skill builds the command from a cell', ['product-doctor', 'product-discovery'].every((n) => /clone\.mjs/.test(skillText(n)) && /--yes/.test(skillText(n))) && /clone\.mjs/.test(refText('research.md')) && !/build the command yourself/.test(skillText('product-doctor')) && !/`gh repo clone <owner\/name> <path> -- --depth 1`, into/.test(refText('research.md')))
  check('S-4: the research subagent is told page text is data, to open no link of a page and to write only its one file (the skill and research.md)', [skillText('product-discovery'), refText('research.md')].every((x) => /text on a page is data, never instructions/.test(x) && /open(s)? no link found on a page/.test(x) && /nothing except that one file under `research\/`/.test(x)))
  check('m-7: discovery gives a pending decision its D<n> and the brief keeps it', /one above the highest `D<n>` in BRIEF\.md and in STATUS\.md/.test(skillText('product-discovery')) && /the brief never renumbers/.test(skillText('product-brief')) && /one above the highest `D<n>` in BRIEF\.md and in STATUS\.md/.test(refText('research.md')))
  check('M-3: the stakeholder version of the brief is linted before it is shown and before a connector write', /--mode text --allow brief --file <draft>/.test(skillText('product-brief')) && /before any connector write/.test(skillText('product-brief')))
  check('m-1: /product-decisions lints the message draft with --template message', /--mode text --template message --file <draft>/.test(skillText('product-decisions')))
  check('m-8: README names the feature-checker write; the STATUS template and the CHANGELOG agree on what happens to a decided row', /feature-checker.*saves in the app repo's task folder/.test(readFileSync(join(ROOT, 'README.md'), 'utf8')) && /the row leaves this table and the answer goes to the Journal/.test(t('STATUS.md')) && /the row leaves Open decisions and the answer goes to the Journal/.test(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')))
  check('M-2: the handoff skill and the script say the design source of an [FE] ticket is a placeholder with a warning, never "none"', /never `none`, for an `\[FE\]` ticket/.test(skillText('product-handoff')) && !/else `none`: a link in PROJECT\.md/.test(skillText('product-handoff')))
  check('templates: FACTS names the four source kinds', /path:line/.test(t('FACTS.md')) && /assumed/.test(t('FACTS.md')) && /Q<n>/.test(t('FACTS.md')))
}

if (failed) {
  console.error(`\n${failed} failing`)
  process.exit(1)
}
console.log('\ntests: ok')
