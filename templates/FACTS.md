# <Epic> — facts

Epic: <slug>
Language: <ru | en>
Updated: <YYYY-MM-DD>

One line per fact: `F<n>` numbered from 1, never reused. Exactly one source per fact, of one of four kinds:
`path:line` (a line that was read: code in a repo, or a file of the epic such as a saved vendor answer in `research/` or a quote in `INTAKE.md`) · a URL (a page that was read) · `Q<n>` (the answer to a data request, once answered) · `assumed` (nobody has checked it; "said by a person" with no saved text is `assumed`).
A claim about a backend service has a `path:line` of code that was read, or it is `assumed`. A fact whose source changes is corrected in this line; the brief refers to the id.

| Id | Fact | Source | Read on |
|---|---|---|---|
| F1 | <one claim, one sentence> | <repo/path/file.py:42 · research/vendor-answer.md:5 · https://… · Q1 · assumed> | <YYYY-MM-DD> |

## Not read
Pages and files that could not be read. A URL here is not a fact source.
| URL or path | What happened | Tried |
|---|---|---|
| <https://…> | <403 · login wall · not public> | <fetch · browser · browser not available> |
