# The Progress Brain

An interactive 2D/3D map of my Obsidian second brain built from [Works in Progress](https://worksinprogress.co) magazine: every essay, the transferable mechanisms it argues for, and the fields those mechanisms belong to.

**Live: https://profsarthak.github.io/wip-brain/**

![The Progress Brain](docs/preview.jpg)

## What you're looking at

The vault has three layers, and the graph keeps them:

| Layer | In the graph |
| --- | --- |
| **Essays** (`#source`), one per Works in Progress article | small pale nodes |
| **Mechanisms** (`#mechanism`), one reusable causal claim each | nodes coloured by their field |
| **Domains** (`#domain`), the broad problem spaces | large glowing hubs with labels |

Every `[[wikilink]]` in the vault is an edge.

- **3D / 2D:** spin the brain in 3D, or flatten it into a map you can pan and zoom.
- **Click any note:** see its core claim, a link to the original essay, and a 2D local graph of its neighbours. Hovering a neighbour lights it up in the main view.
- **Timeline:** press play to watch the brain grow issue by issue.
- **Search:** press `/`. Domains in the legend are clickable. Every note has a shareable link (`…/wip-brain/#Note Title`).

## Updating it

After new notes land in the vault, run:

```bash
python publish.py
```

The script reads the vault (it never writes to it) and rebuilds `docs/graph.json`. If anything changed, it commits and pushes, and GitHub Pages redeploys in a minute or two. If nothing changed, it does nothing.

| Option | |
| --- | --- |
| `--no-push` | rebuild only. Preview locally with `python -m http.server -d docs` and open http://localhost:8000 |
| `--vault PATH` | vault location (default: `~/Documents/Obsidian/Works in Progress`) |

To run it from a fresh machine: `gh repo clone profsarthak/wip-brain`, then `python publish.py`. It needs Python 3.8+ and nothing else.

## What gets published

Only note titles, links, issue numbers, domain membership, and the first paragraph of each note's *Core claim* (essays), *Definition* (mechanisms) or *Core problem* (domains). The full notes stay in the vault.

## How it's built

- `publish.py`: standard-library Python. It parses the vault's folders, tags, sections and wikilinks.
- `docs/`: a static page with no build step. It uses [3d-force-graph](https://github.com/vasturiano/3d-force-graph) on three.js with bloom, HTML labels for domains, and a hand-drawn SVG for the 2D local graph.

Unofficial reader project. Essays © their authors.
