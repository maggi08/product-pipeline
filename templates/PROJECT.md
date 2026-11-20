# <Company> — product project

Product repo: <path>
Updated: <YYYY-MM-DD>

## App repos
| Repo | Path | task_path | What it is | Label |
|---|---|---|---|---|
| <dashboard> | <~/programming/dashboard> | <.claude/tasks/ or an absolute path> | <web app for hosts> | <optional: the name tickets use in [FE <app>]; empty = the repo name> |

## Service repos
Backend and other services the epics read before any claim about them. Not an app repo: no tasks live there.
| Repo | Local path | Clone source |
|---|---|---|
| <billing-service> | <~/programming/billing-service> | <gh repo clone org/billing-service> |

## Jira
- Site: <name.atlassian.net>
- Projects: <KEY — name, which team>
- Issue types: <Epic, Story, Task, Sub-task, Bug>
- Rule: <sub-tasks live in their parent's project; per-team projects mean Tasks linked to the epic>
- Mode: manual <the user creates the issues from JIRA.md and sends the keys back | connector: name>

## Data route
- Client: <psql | other>
- Tunnel command: <the command, run by the user, with no password or token in it (those stay in the user's environment or ~/.pgpass)>
- Databases: <one per service: name, read-only role (never its password), what it holds>
- Notes: <what cannot be joined across databases; exports are joined locally>

## Languages
- Chat: <the user's language>
- Epic files: <default for new epics' `Language:`>
- Stakeholder documents: <language>

## Stakeholders
| Name | Role | Decides | Vocabulary |
|---|---|---|---|
| <name> | <role> | <what they decide> | <words they use for the product's things, and words to avoid> |

## Documents
- Publish to: <connector name | file>
