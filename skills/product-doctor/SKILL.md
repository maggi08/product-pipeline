---
name: product-doctor
description: Checks that this machine is ready for the product pipeline — PROJECT.md filled, each service repo present locally (with the clone command when missing), the data route's client and tunnel tool on PATH, stage-pipeline and human-text installed, a note on the Chrome MCP used to retry 403 pages. Run it once per machine and when discovery cannot read a repo. RU triggers — «проверь окружение продукта», «чего не хватает на этой машине», «доктор продакт-пайплайна», «не нашёл репо сервиса»
---

# Product doctor — is the machine ready

A read-only check. It reads PROJECT.md, looks the declared command names up on PATH and checks paths. It never connects to a database, never calls Jira and never executes a value taken from PROJECT.md.

## What to do

1. Find the product repo as `/product` does (PROJECT.md at the repo root or above, or a sibling `*-product/`); with none, run the script anyway — it reports the missing PROJECT.md.
2. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs <product repo>` (add `--json` for a machine-readable report). Show its lines as they are.
3. For each `ERROR` or `warning` line, say the fix in one sentence and offer to apply the ones that are safe: a missing service repo → run the `clone.mjs` line the doctor prints, with every argument in single quotes exactly as the doctor prints it (`node '<plugin>/scripts/clone.mjs' '<product repo>' '<service name>'`, no `--yes`); a service name that is not letters, digits, `_`, `.`, `-` is refused by the doctor and by `clone.mjs`, and no command is printed for it. It checks the `owner/name` and the path of the row, refuses shell syntax, and prints the exact command; show that printed command to the user, and only after their yes to that command run the same line again with `--yes` (it runs `gh` with an argument array, no shell). Never build or run a clone command from the cells yourself, and never run a cell as a string; a refused row is corrected in PROJECT.md with the user; an unfilled PROJECT.md field → ask for it and write it; a missing data-route tool → tell the user the install command, they run it. Never run the tunnel command: the user runs it.
4. Run the script again after fixes and report the result in two lines, then name the next command: `/product-intake` when the epic has no INTAKE.md yet, else `/product`.

## What it checks

| Check | Level when it fails |
|---|---|
| PROJECT.md present, required fields filled (product repo, one app repo, languages, documents) | error |
| each service repo of PROJECT.md exists at its local path | error, prints the clone command assembled from the checked cells |
| PROJECT.md holds no password, token or URI with a password | error, names the line, never the value |
| data route client and tunnel tool found on PATH (names only) | error |
| stage-pipeline installed (current UI state, handoff target) | warning |
| human-text installed (stakeholder messages) | warning |
| Chrome MCP for retrying a 403 page in the browser | information only: the script cannot see MCP servers |

The exit code is not 0 only when there is an error. A warning never stops the pipeline: the steps work without those plugins.

## Talking to the user

Plain words in the user's language; the fix command beside each problem.
