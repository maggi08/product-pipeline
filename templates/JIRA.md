# <Epic title> — Jira

Status: <not created | partly created | created>
Updated: <YYYY-MM-DD>
Site: <name.atlassian.net>
Project: <KEY — name>

<!-- Written by /product-split, keys filled in by /product-jira. Two parts. The key map is for the product repo only: it is the one place where task ids (T<n>), Jira keys and decisions (D<n>) meet; the lint skips its lines for epic ids but reads its Summary column. Everything below it is the text that goes into Jira and is written for people who do not have the epic: no T<n>, D<n>, F<n>, Q<n>, P<n>, no section references, no word "brief", no path into the product repo (data/, research/, BRIEF.md). A ticket names another ticket by its summary in quotes; a decision is written out as "question: recommendation → who decides". Each ticket heading ends with an HTML comment carrying its key map Id, as in the headings below: it is how the ticket text is found by its key, keep it, and write the heading's summary exactly as the map's Summary. A ticket created before the plugin may carry its Jira key at the start of the heading instead (`<KEY> · Sub-task — ...`): that is the same link, and the key must be the Key of its map row. The lookup is key → map row → the heading with that Id comment or that key at its start; every map row has exactly one heading and every key is on one row only. The skeleton stays English whatever the language of the prose: the section headings, the labels (`**Why**`, `**What**`, `**Deliverables**`, `**Criteria**`, `**Open decisions**`, `**Out of scope**`), the ticket type words (Epic, Story, Task, Sub-task), the tags ([BE], [FE <app>], [Design]), WHEN/THEN, and the word "contract" in a [BE] subtask's first deliverable; only the prose under the labels is in the stakeholder-documents language. Delete each comment but the id comments when its section is written. -->

## Key map
<!-- One row per ticket. Id: E for the epic, T<n> for a task, T<n>.<m> for its subtasks. Key: `—` until created. Parent: the Id of the parent. Blocked by: Ids of the tickets that must finish first (one Jira link "blocks" from each of them to this one). Decisions: the D<n> the ticket waits for or depends on. Order: the creation order (epic, then tasks, then subtasks, links last); `wait D<n>` for a ticket created only after that decision. -->
| T | Key | Type | Summary | Parent | Blocked by | Decisions | Order |
|---|---|---|---|---|---|---|---|
| E | — | Epic | <summary> | — | — | all | 1 |
| T1 | — | Story | <summary> | E | — | D1 | 2 |
| T1.1 | — | Sub-task | [BE] <summary> | T1 | — | D1 | 3 |
| T1.2 | — | Sub-task | [FE <app>] <summary> | T1 | T1.1 | — | 4 |

## Tickets

### Epic: <summary> <!-- E -->

**Why**
<Who has the problem and what it costs them, in the readers' words. Numbers come with where they come from.>

**What**
1. <task summary: one line of what it delivers>

**Out of scope:** <what this epic does not do.>

**Success:** <how we will know it worked: the metrics in words.>

**Open decisions** (recommendation → who decides)
- **<question>:** <recommendation> → <who decides>

### Story: <summary> <!-- T1 -->

**Goal**
<What changes for the user.>

**Sub-tasks:** "<[BE] summary>", "<[FE app] summary>".

**Open decision:** <the decision written out as "question: recommendation → who decides", or "none".>

### Sub-task: [BE] <summary> <!-- T1.1 -->

**What**
<One or two sentences.>

**Deliverables**
1. The API contract (endpoints, fields, statuses, errors), reviewed by the frontend before implementation.
2. <the implementation>

**Criteria**
- WHEN <condition> THEN <observable result>

**Depends on:** <the decision written out as "question: recommendation → who decides", or "none".>

**Out of scope:** <what this subtask leaves alone.>

### Sub-task: [FE <app>] <summary> <!-- T1.2 -->

**What**
<One or two sentences. The frontend builds against mocks written from the contract until the backend is deployed.>

**Criteria**
- WHEN <condition> THEN <observable result>

**Depends on:** "<[BE] summary>" for the contract; <a decision written out, or "none".>

**Out of scope:** <what this subtask leaves alone.>
