# product-pipeline

Product work before code: a stakeholder's ask goes through intake, discovery, a brief, decisions, a split and Jira tickets, and comes out as a handoff that [stage-pipeline](https://github.com/maggi08/claude-pipeline/tree/main/plugins/stage-pipeline) plans the code from.

The plugin owns the process and the files. The files live in a product repo of their own (`<company>-product/`), next to the app repos and never inside one, so an epic that spans several repos has one home.

## Installation

The plugin is listed in the `magzhan` marketplace of [claude-pipeline](https://github.com/maggi08/claude-pipeline), pinned to a version tag:

```bash
claude plugin marketplace add maggi08/claude-pipeline
claude plugin install product-pipeline@magzhan
```

Optional companions, used when installed and never required: `human-text` (stakeholder messages and briefs) and `stage-pipeline` (the app-side planning that reads the handoff).

Restart Claude Code, then run `/product`. This is version 0.1.1. The plugin has 9 skills and 1 agent.

## The flow

| Step | Command | Output | Gate |
|---|---|---|---|
| 0 | `/product` | where the epic stands and the next command; a new epic or an adopted folder | none |
| 1 | `/product-doctor` | PROJECT.md filled, service repos cloned, data-route tools, companion plugins (`scripts/doctor.mjs`) | once per machine |
| 2 | `/product-intake` | INTAKE.md: who asked, quotes verbatim, the ask restated, unknowns, repos marked as assumptions | none |
| 3 | `/product-discovery` | FACTS.md (one source per fact), research/ with capability matrices, data requests `data/Q<n>-<slug>.md` | facts have sources; backend claims have read code |
| 4 | `/product-brief` | BRIEF.md from facts by reference, `scripts/product-lint.mjs`, the `brief-review` agent in a clean context, a version for stakeholders | brief lint clean; user sign-off in STATUS.md |
| 5 | `/product-decisions` | one stakeholder message per decision group (a recommendation and its cost per numbered item, open questions apart, a text check before sending); answers recorded as decided | brief signed |
| 6 | `/product-split` | epic → tasks → subtasks `[BE]` / `[FE <app>]` / `[Design]` with WHEN/THEN criteria; `JIRA.md` with the key map and ticket texts, `product-lint.mjs --mode jira` | brief signed; open data requests are a warning |
| 7 | `/product-jira` | paste-ready tickets, creation order and links; keys written back into JIRA.md, BRIEF.md, STATUS.md; drift check of the created tickets; a connector only for the PROJECT.md site | lint clean; data requests answered (a warning) |
| 8 | `/product-handoff <key>` | one `PRODUCT-HANDOFF.md` per FE or BE ticket (`H<n>` criteria, decisions in words, out of scope, the contract) written into the app repo's task folder after the user's yes, a copy in `epics/<slug>/handoff/`, `product-lint.mjs --mode handoff`, then `/feature-checker <key>` → `/stage-plan <key>` in the app repo (`scripts/handoff.mjs` assembles it) | tickets exist; no epic ids in the file |

`/product` names the command that comes next in phase order.

The product repo layout (the folders of an epic), the epic ids and the phase gates: [references/product-repo.md](references/product-repo.md). Starting files: `templates/PROJECT.md`, `templates/STATUS.md`, `templates/INTAKE.md`, `templates/FACTS.md`, `templates/BRIEF.md`, `templates/message.md`, `templates/JIRA.md`, `templates/PRODUCT-HANDOFF.md`, `templates/data-request.md`, `templates/capability-matrix.md`. Discovery rules: `references/research.md`.

## Scripts

```bash
node scripts/product-lint.mjs <epic dir> --mode brief|jira|text|handoff   # one line per finding: file:line — rule — message
node scripts/doctor.mjs [<product repo>]                                   # what is installed and filled in
node scripts/clone.mjs <product repo> <service name> [--to <tmp path>] [--yes]  # the checked clone command of a service repo (--to: a folder inside the system temp dir); runs only with --yes
node scripts/handoff.mjs <epic dir> <KEY> [--repo <app>]                   # assembles PRODUCT-HANDOFF.md, read-only
```

## The product repo

One repository per company, next to the app repos and never inside one (`<company>-product/`): `PROJECT.md` (sites, app repos with their paths, the data route, documents, language), and one folder per epic under `epics/<slug>/`. The files follow the epic's `Language:`; stakeholder documents follow the language in PROJECT.md; the chat follows the user. The plugin never writes into an app repo except the one `PRODUCT-HANDOFF.md` per ticket, into its task folder and only after the user's yes, and the map that `/stage-pipeline:feature-checker` saves in the app repo's task folder when discovery runs it (that tool's own write; discovery says so first). No file of the product repo holds a password, token or URI with a password.

## Development

```bash
node scripts/validate.mjs   # manifest, frontmatter, links, language, README counts, ids
node scripts/test.mjs       # fixture copies with one planted defect each
```

CI runs both on every pull request and on every push to `main`. A release: raise `version` in `.claude-plugin/plugin.json`, add the `## <version>` section on top of `CHANGELOG.md`, merge into `main` — CI creates the tag `v<version>`; then raise `ref` of the `product-pipeline` entry in claude-pipeline's `.claude-plugin/marketplace.json`.

To try a change before a release: push a branch, then in a local clone of claude-pipeline set the entry's `ref` to that branch and run `claude plugin update product-pipeline`. Do not merge that `ref` into claude-pipeline's `main`.
