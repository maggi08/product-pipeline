# Q<n> — <short title>

Status: open
<!-- Status line is exactly `Status: open` or `Status: answered <YYYY-MM-DD>`; the file name is data/Q<n>-<slug>.md -->

## Question
<One question that numbers can answer.>

## Why it matters
<Which decision or claim waits for it, as `D<n>` or `F<n>` where they exist, and what changes with the answer.>

## Query
Written from the models or the schema of the service, read in the repo — never from memory. Name the files read.
One block per database; the query lives in a runnable file the user passes to the client (`psql -f`), not copied here.

### <db name, per PROJECT.md>
- Models read: <repo/path/models.py:line>
- Runnable file: `data/Q<n>-<db>.sql`

## Where it runs
<who runs it, through which route from PROJECT.md (client, tunnel), against which database and role. Read-only.>

## Export plan
A join across databases is planned as an export from each side and a local join, from the start.
- Exports: <one per database: columns, file name `*.csv` (gitignored; holds production rows)>
- Local join: <script `data/scripts/<name>`, join key>
- Aggregated output kept in the repo: <`*.out`>

## Check on the result
- Every value of every enum column in the result is listed and checked against the code: <enum, where it is defined>
- A rate that goes to a stakeholder comes with the top accounts' share of it.
- An automation risk comes with the share of the flow that is manual.
- Categories are named as users see them in the UI, not as the enum spells them.

## Answer
<Empty until answered. The numbers, the date, who ran it; then the F<n> lines they became.>
