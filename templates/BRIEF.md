# <Epic title> — product brief

Status: <draft | in review | signed off>
Language: <the stakeholder-documents language from PROJECT.md>
Updated: <YYYY-MM-DD>
Signed off: <not yet | YYYY-MM-DD>

<!-- Comments in this template are instructions: delete each one when the section is written. The brief refers to facts by id; it never carries a code path or a code detail. A rewrite of a fact is a change to one line of FACTS.md, not to the prose. The skeleton stays in English whatever the language of the prose: headings, column names and the state words (`open`, `pending data`, `decided`, `no baseline`) are read by the lint; only the text inside is in the stakeholder-documents language. Write a quarter as "Q1 2027" or in words, never as a bare Q<n>, which is a data request. -->

## Summary
<!-- Three to six sentences: who has the problem, what this epic changes, the deliverables as a short numbered list. No claim here that is not in What exists, Problems or Scope. -->

## What exists
<!-- One claim per line, each ending with its fact id in the form F<n> (defined in FACTS.md). A claim without an id is not written; a claim whose fact is `assumed` says "assumed" in the sentence. Categories carry the name users see in the UI, with the enum value once in parentheses. -->
- <claim> (F<n>)

## Problems
<!-- Each problem is a hypothesis and says how it will be validated: a data request (Q<n>), a stakeholder answer (D<n>), a prototype. -->
| Problem | Hypothesis | How we validate |
|---|---|---|
| <problem> | <what we think is true> | <Q<n> · D<n> · another way> |

## Users
<!-- Who is affected and how they meet the problem today and what changes for them. Use the words from the stakeholders table in PROJECT.md. A sentence about how things are now is a claim: it ends with its fact id. -->
- **<user>:** <how they meet the problem today; what changes for them> (F<n>)

## Goals and metrics
<!-- Every metric has a baseline: the number today with its fact (F<n>), or exactly `no baseline — Q<n>` naming the data request that will give it. A rate that goes to a stakeholder carries the top accounts' share of it. -->
| Goal | Metric | Baseline | Target |
|---|---|---|---|
| <goal> | <metric> | <number (F<n>) · no baseline — Q<n>> | <target> |

## Scope
### v1
<!-- One row per item. The Task column is `—` until /product-split fills it with the task id (T<n>) from Epic and tasks; after the split every v1 row has one. -->
| Item | Task |
|---|---|
| <item> | — |

### Later
- <item>

### Out
- <item and why it is out>

## How it works
<!-- The flows in plain words, step by step, for the reader who does not know the code. Name UI labels as users see them. -->

## Decisions
<!-- One row per decision, id D<n> numbered from 1, never reused. State is one of: `open` · `pending data Q<n>` · `decided <YYYY-MM-DD> <who>`. A `pending data Q<n>` row has Recommendation `—`: no option and no order is recommended until the numbers arrive. Cost is what each way costs (effort, risk, what breaks, who pays); `unknown — Q<n>` is allowed. Owner is a person or a team that decides. -->
| Id | Question | Options | Recommendation | Cost | Owner | State |
|---|---|---|---|---|---|---|
| D1 | <question> | <option a · option b> | <recommendation> | <cost> | <who decides> | open |

## Research
<!-- Links to the capability matrices and notes under research/, one line each with what it answers. The matrix itself stays in its file. -->
- <research/matrix-name.md — what it answers>

## Epic and tasks
<!-- Written by /product-split. Epic title, then a table with one row per task, the task id T<n> in the first column. Stays empty until the split. -->

## Sequencing
<!-- What goes first and why; what waits for which decision or data request. -->

## Risks
<!-- One row per risk: what can go wrong, the effect, the mitigation. An automation risk names the share of the flow that is handled manually today. -->
| Risk | Impact | Mitigation |
|---|---|---|
| <risk> | <effect> | <mitigation> |

## Open questions and data requests
<!-- Every open question, and every data request (Q<n>, file data/Q<n>-<slug>.md) with the decision or metric that waits for it. -->
| Id | What is asked | Waits for it |
|---|---|---|
| Q<n> | <question> | <D<n> or metric> |
