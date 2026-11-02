# Contribute

Thanks for wanting to share a tool with the WorldAces community! The idea is simple: each tool is
its own self-contained folder, easy to find and use without reading the code.

## Add a new tool

1. Fork the repo and create a branch.
2. Create `tools/<your-tool-name>/` (short name, lowercase, with dashes or underscores).
3. Inside:
   - `README.md` — required. It should include: what the tool does, an example command,
     expected input format (with an example), output format, and your username as author.
   - script(s) — a standalone script is preferred (no internal repo dependencies), so someone can
     also just copy the file.
   - `requirements.txt` — Python dependencies (or `package.json` if Node).
   - an example input file (`example_input.json` or `.csv`) small enough to be versioned.
   - (optional) `metadata.json` if you want the tool to appear on the future GitHub Pages page or be
     runnable in the browser — see below.
4. Add a row in the main `README.md` table.
5. Open a pull request. The PR template will guide you on the information to provide.

## Review

- Every PR must be reviewed by at least one maintainer before merging (branch protection enabled on
  `main`).
- We mainly check: the script runs on the provided example, it has no hidden network calls or
  destructive behavior, and the README allows an external person to use it without questions.
- No need for perfect code — a working script with a good README is better than a perfect tool that
  is never shared.

## Update an existing tool

Same idea: open a PR for the relevant folder. As a courtesy, mention the original author in the PR
(`@pseudo`) if identifiable, unless they are already a repo maintainer.

## `metadata.json` (optional, for the community page)

```json
{
  "name": "ledger_bars",
  "description": "Income vs expense bar chart from a transaction export",
  "author": "pseudo-github",
  "tags": ["visualization", "economy"],
  "entrypoint": "ledger_bars.py",
  "runnable_in_browser": false
}
```

`runnable_in_browser: true` signals a candidate for running via Pyodide on the GitHub Pages page
(see the README roadmap) — in practice, this means no heavy dependencies unsupported by Pyodide,
no mandatory disk or network access.

**Node / TypeScript tools with their own web app**: add a `build:browser` script to the tool's
`package.json` (the Pages workflow runs `npm ci && npm run build:browser` for every tool that has
one) and point `"browser_build"` in `metadata.json` to the output folder (it must contain an
`index.html`; it is published as `docs/<tool>/`). See `tools/roster_analyst`.

## Repo rights

- **Maintainers** (direct write access): small trusted core, can merge PRs and manage repo settings.
- **Everyone else**: fork + pull request. This is the normal path, including for maintainers on large
  changes.
- A `CODEOWNERS` file automatically routes PRs touching `tools/<x>/` to one or more default reviewers
  if needed (not enabled by default, add on a case-by-case basis).
