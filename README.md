# WorldAces Community Tools

Community toolbox for [WorldAces](https://worldaces.site) (volleyball game simulation).
One place to find scripts made by players, with clear instructions for how to use them —
and an easy place to propose your own.

## Find a tool

Each tool lives in its own folder under [`tools/`](./tools), with its README, dependencies,
and an example input file.

| Tool | Description | Author |
|---|---|---|
| [`ledger_bars`](./tools/ledger_bars) | Two-panel bar chart of income vs expenses from a JSON/CSV transaction export | @Gutek |
| [`roster_analyst`](./tools/roster_analyst) | 5-1 lineup, academy moves, recruitment targets and players to sell from your roster CSV — in-browser settings editor with exportable `params.json` (TypeScript, CLI + web) | @Peariforme |

*(This table is updated whenever a new tool is accepted — see [CONTRIBUTING.md](./CONTRIBUTING.md).)*

## Use a tool

Each tool is independent: go to its folder, read its `README.md`, install its
dependencies (`pip install -r requirements.txt`, or `npm ci` for Node tools) and follow the
instructions. Some tools also run directly in the browser from the GitHub Pages site.

## Contribute

Anyone in the community can propose a tool or an improvement. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the process (expected structure, pull requests, review).

## Roadmap

- [x] Repo structure + first tool (`ledger_bars`)
- [ ] GitHub Pages page listing the tools with screenshots / output examples
- [ ] Run some scripts directly in the browser (via Pyodide) for tools that are suitable
      (no heavy dependencies, no disk access)
- [ ] Direct data retrieval from worldaces.io (requires handling authentication —
      to do once an agreement is reached with the game developer about API usage)
- [ ] GitHub Action validation that runs each tool on its example to catch regressions

## License

MIT — see [LICENSE](./LICENSE). Each contributor remains credited as the author of their tool
(mentioned in the tool README and in the table above).
