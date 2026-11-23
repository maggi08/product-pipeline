# <Subject> — capability matrix

Epic: <slug>
Researched: <YYYY-MM-DD>
Sources: official docs and pages read; a page that could not be read is under "Not read" with its URL.

Rows are what the epic needs, columns are the products compared. A cell is the answer plus its status:
- `confirmed <source>` — a page or document that was read (URL or `path:line`), or a vendor's written answer;
- `confirm with vendor` — the docs do not say, or the page could not be read, or the answer is inferred. Never `yes` or `no` without a status.

| Capability | <Vendor A> | <Vendor B> |
|---|---|---|
| <what the epic needs> | <yes · no · partial — confirmed <URL>> | <? — confirm with vendor> |
| Access friction (cost, certification, who pays) | <short — confirmed <URL>> | <short — confirm with vendor> |

## Confirm with vendor
One line per cell marked `confirm with vendor`: the vendor, the question to ask, the F<n> or D<n> that waits for it.
- <vendor — question — waits for>

## Not read
| URL | What happened | Tried |
|---|---|---|
| <https://…> | <403 · login wall> | <fetch · browser · browser not available> |
