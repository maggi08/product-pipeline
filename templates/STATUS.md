# <Epic> — product status

Epic: <slug>
Language: <ru | en>
Started: <YYYY-MM-DD>
Product repo: <path>
Jira epic: <key | not yet>

## Phases
| Phase | State | Signed off | Notes |
|---|---|---|---|
| Intake | open | — | |
| Discovery | not started | — | |
| Brief | not started | — | |
| Decisions | not started | — | |
| Split | not started | — | |
| Jira | not started | — | |
| Handoff | not started | — | |

Phase states: not started → open → done. A phase with a sign-off gate is done only with a date in "Signed off"; a phase read from the files of an adopted epic is `done` with "by reading" in Notes and Signed off `—` until the user gives the date.

## Open decisions
| Id | Question | Recommendation | Owner | State |
|---|---|---|---|---|
| D1 | <question> | <recommendation> | <who decides> | open |

State: open → `pending data Q<n>` → open (when the request is answered) → decided <YYYY-MM-DD> <who>. A `pending data Q<n>` row has Recommendation `—`. When a decision is `decided`, BRIEF.md carries the state; the row leaves this table and the answer goes to the Journal.

## Keys
| Task | Jira key | Brief decisions |
|---|---|---|
| T1 | — | |

## Adopted from
Filled only when files were brought in from elsewhere. Sources are never changed or moved.
| From | To | Note |
|---|---|---|
| <source path> | <epics/slug/BRIEF.md> | <copied on YYYY-MM-DD> |

## Journal
<!-- One line per working session: YYYY-MM-DD — what was done — what is next. -->
