# work-map

A live, draggable map of what Claude is doing, in your browser. Based on
[lot-map](https://github.com/alexeyw/lot-map) by Aleksei Volodin (MIT, see LICENSE): its way of sorting calls into stations is kept.

- The main agent sits in the middle with the stations it uses: Files, Shell, Network, Memory, Skills, Hooks and more.
- Every subagent is a node of its own, linked to the main agent (or to the subagent that started it), with its own stations, its type, task and model.
- Drag nodes, drag the background to pan, wheel or pinch to zoom, Fit (F) to see everything. Click a node for its recent calls.
- Double-click a station to open it: its calls appear as small nodes by target (a file name, a site, a program, a skill), the busiest eight, each with a count; click one for its calls. Double-click again, or use Show/Hide targets in its details, to close it; C closes all.
- Each subagent shows the tokens it used so far; its details split them into input, output and cache. The main agent's total is in the top bar and its details.
- Colour by model: haiku, sonnet, opus and fable each have their own colour on the core, the subagents and their links, with a legend.
- Search (/) by name, by a subagent's type, task or model, or by the calls behind a station, such as a file or command; Enter goes to the next match. Pause (P) stops the graph moving while you look.
- Forces (G), as in Obsidian's graph settings: Repel, Gap, Link distance, Link strength and Centre, live, remembered in this browser, with Reset.
- A living graph: nodes pop in when first used and fade out after 2 minutes unused; pulses fly along the links for every call.

## Install

At the prompt of a terminal session:

```
/plugin install work-map --marketplace ChenZenMFK/claude-work-map
```

Answer `y` to add the marketplace, then choose a scope. From a shell:

```bash
claude plugin install work-map --marketplace ChenZenMFK/claude-work-map
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ChenZenMFK/claude-work-map`, then **Add plugin**.

Needs Python 3 for the local server: `python3` on macOS and Linux; on Windows `py` (the Python launcher) or `python` from python.org, since the `python3` there is often only a placeholder for the Microsoft Store. Built and used on Claude Code 2.1.321 on macOS; Windows and Linux are covered by its tests.

## Use

Open it with the **Open map** button in the pane or `/work-map`. One small local server
(`server/serve.py`, Python 3) serves every session on one address that stays the same, so a bookmarked
or open tab keeps working across sessions; the picker at the top chooses the session, or follows the
latest. A session finds the server or starts it on its own, apart from Claude Code, so short print-mode
runs (chat windows built on `claude -p`) never wait on it. It stops itself after 30 minutes with no
session saving, and comes back on the same address with the next one; an open tab reconnects by itself.
It opens the page with `open` on macOS, `explorer.exe` on Windows and `xdg-open` on Linux. It binds
127.0.0.1 only, the address carries a random key kept in `~/.claude/work-map/server.json`, and other
websites are refused. Each session's state is saved to `~/.claude/work-map/<session>.json`; files older
than a week are deleted. No model calls, no credits: the map is drawn on your computer.

## Licence

MIT, see LICENSE. Based on lot-map by Aleksei Volodin (github.com/alexeyw/lot-map); the browser map, its server and page are by Stefan Kiefer.
