---
name: product-split
description: Splits a signed brief into an epic, tasks and subtasks ([BE], [FE <app>], [Design]) — each subtask with WHEN/THEN criteria, the decisions it waits for and what is out of scope, the first deliverable of every [BE] subtask the API contract — writes the task ids into BRIEF.md, and writes JIRA.md with the key map and ticket texts for Jira readers, then runs the Jira lint. Warns about open data requests first. Use after the brief is signed, or when the user asks to split the epic into tasks. RU triggers — «разбей эпик на задачи», «составь задачи и подзадачи», «черновик тикетов»
---

# Product split — tasks a Jira reader can pick up

The split turns the scope of the brief into tickets. The tickets are read by people who have never seen the brief, so the codes of the epic stay in the product repo, in the key map of `JIRA.md`, and nowhere else. Layout, ids, gates: `${CLAUDE_PLUGIN_ROOT}/references/product-repo.md`. Template: `${CLAUDE_PLUGIN_ROOT}/templates/JIRA.md`. Criteria and the contract rule are stage-pipeline's: `WHEN <condition> THEN <observable result>`; a backend subtask starts with the API contract.

## Steps

1. **Read the start and check the gates.** `STATUS.md`, `BRIEF.md` (scope v1, decisions, sequencing, risks), `PROJECT.md` (App repos: the app names; Jira: site, projects, issue types, the sub-task rule; the stakeholder-documents language). The brief must be signed (the contract's definition in "Phases and gates" of `${CLAUDE_PLUGIN_ROOT}/references/product-repo.md`: a date in the Brief row's Signed off and `Updated:` not later than it); else stop and name `/product-brief`. A Brief `done` with Signed off `—` (an adopted brief) is not signed: ask the user for the date first. **Data before Jira:** list the files `data/Q<n>-<slug>.md` whose line is `Status: open` and name each with the decision or metric that waits for it, as a warning: tickets written before the numbers usually need a second edit. The user decides whether to split now.
2. **Split.** Epic → tasks → subtasks, from the v1 scope:
   - Every scope v1 item is covered by a task; a task is a story or a task in the project's issue types, one outcome a user or a team can see. One epic.
   - Subtasks by who builds them: `[BE]`, `[FE <app>]` (one per app; `<app>` is the Label cell of PROJECT.md App repos when the row has one, else its Repo cell, exactly), `[Design]`. A project whose rule is "sub-tasks live in the parent's project" and whose teams have separate projects gets tasks linked to the epic instead of subtasks: PROJECT.md's Rule line says which.
   - A task or subtask that depends on an open decision is still written; its key map row says `wait D<n>` in Order and it is created after the answer. A decision recommended by the brief is not assumed: the ticket's "Depends on" writes the decision out.
   - Ids: `E` for the epic, `T<n>` for a task from 1, `T<n>.<m>` for its subtasks; never reused. Dependencies go to the key map's Blocked by column, one blocking link each.
   - Show the user the tree (ids, types, summaries, parents, blockers) and ask whether it is right before writing the texts. A change is applied before going on.
3. **Write the ticket texts** into `JIRA.md` from the template, for Jira readers. The prose is in the stakeholder-documents language; **the skeleton stays English** whatever that language is (as in BRIEF.md): the section headings, the labels `**Why**`, `**What**`, `**Deliverables**`, `**Criteria**`, `**Open decisions**`, `**Out of scope**`, the type words `Epic` / `Story` / `Task` / `Sub-task`, the tags `[BE]` / `[FE <app>]` / `[Design]`, `WHEN` / `THEN`, and the word "contract" in the first deliverable of a `[BE]` subtask. The lint reads those words.
   - **Heading and map are one ticket.** Every ticket heading ends with an HTML comment holding its key map Id (`### Sub-task: [BE] <summary>` followed by the comment `T1.1` in comment tags, as in the template), and the heading's summary is written exactly as the map's Summary column: the map's summary is what `/product-jira` pastes, and `/product-handoff` finds a ticket's text by its key: key → key map row → the heading with that Id comment, or with that key at the start of its heading (`<KEY> · Sub-task — ...`, how a ticket created before the plugin is written; the key must equal its row's Key). Every row has exactly one heading, keys are unique, summaries are unique. Keep the id comment when the template's other comments are deleted.
   - **Epic:** why, what (the tasks in one line each), out of scope, success, and an **Open decisions** list written out, one item per open decision, as `question: recommendation → who decides`. When none is open, one item "None".
   - **Subtask:** what, deliverables, criteria, depends on, out of scope. A `[BE]` subtask's first deliverable is the API contract (endpoints, fields, statuses, errors) reviewed by the frontend before implementation; an `[FE <app>]` subtask builds against mocks written from that contract meanwhile and says so. Each criterion is one line `WHEN <condition> THEN <observable result>`: a code, a field, a screen state; no tool names and no "works correctly".
   - **No epic codes in any text**: no `T<n>`, `D<n>`, `F<n>`, `Q<n>`, `P<n>`, no section references, no "brief". A ticket names another by its summary in quotes (the key replaces it after creation); a decision is written out; evidence goes into the ticket it produced, not behind an id. Categories carry the name users see in the UI. A number comes from a fact the brief cites and says where it comes from.
4. **Write the ids back.** BRIEF.md "Epic and tasks": the epic title, then a table `| Id | Task | Key |` with one row per task (`T<n>`, the task summary, `—`); and in the scope v1 table the Task column becomes the task id for every item; a scope written as a v1 / Later / Out matrix gets a Task column added to it, filled for every item in its v1 column (the brief lint reads that column once it is there). Neither edit changes `Updated:` (contract, "Phases and gates"). STATUS.md Keys table: one row per task and subtask (`T<n>`, `—`, its decisions).
5. **Lint.** Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/product-lint.mjs <epic dir> --mode jira` and `--mode brief`; each prints one line per finding as `file:line — rule — message`. Fix each at its cause, never by deleting the row or the rule. The Split phase is `done` when both are clean and every v1 item has a task: STATUS.md Split → `done`, a Journal line, next command `/product-jira`.
6. **Report** in the user's language in three or four lines: the number of tasks and subtasks, tickets that wait for a decision, open data requests, lint state, and `/product-jira`.

## Gates

- No split for an unsigned brief. Open data requests are a warning, never silently skipped.
- Every subtask has criteria; every `[BE]` subtask starts with the contract; every `[FE]` names an app of PROJECT.md.
- Nothing is created in Jira by this skill.

## Talking to the user

Plain words in the user's language. Questions through the structured question tool with a recommended option first. Report in three or four lines and the one next command.
