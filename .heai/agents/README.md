# agents

One file per agent, and nothing else: a name, a kind, and the prompt the agent starts from.
An agent here is not in the architecture map. The map says where each territory is and what anyone working or judging there must know; these files say who does the work and who judges it; and a task says which of each it gets.

| kind | files | how it is prompted |
| --- | --- | --- |
| `worker` | `cli`, `systems`, `tui`, `web`, `release` | its file, then `heai-architect context <territory>` for the task's territory, then the task |
| `gate` | `judge`, `reviewer`, `verifier` | its file, then `heai-architect context <territory>`, then the task and the diff |

A worker is an area of expertise, not a tool: `cli` works in any of the four Node command-line tools, and a new tool needs no new agent.
A gate is a step in the landing flow: each reads the change after the scope gate has passed it, and its verdict is the event that moves the flow on or refuses it.
The human approval is a step in the same flow and needs no file: a transition flow lets only `human` take, `heai-flow advance <id> approved` at the shell.

The default worker for a territory, when a task names none:

| territory | worker |
| --- | --- |
| `architect`, `tasks`, `flow`, `reactor` | `cli` |
| `pod` | `systems` |
| `operator` | `tui` |
| `operator-web` | `web` |
| `platform`, `tool-source` | `release` |
| `process` | `cli` |

The producer of a task may pick any agent; this table is what the scripts fall back to.
