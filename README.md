# AI Contribution Policy Map

**How do popular GitHub repositories treat AI-assisted contributions?**
This project reads the contribution docs of a few hundred well-known repositories and records, for each one:

| Question | Values |
| --- | --- |
| AI-assisted contributions | banned · human-written text only · allowed with disclosure · allowed · not stated · needs review |
| AI agents opening PRs on their own | forbidden · allowed · not stated · needs review |
| CLA or DCO sign-off | required / not found |
| Issue or discussion first, assignment | required · for larger changes · not required · not stated |
| Who can open PRs | open · collaborators only (`pull_request_creation_policy`) · PRs disabled · not accepted (stated in docs) |
| Anti-automation signals | workflows such as [AgentScan](https://github.com/MatteoGabriele/agentscan-action), [unattended-pr-guard](https://github.com/scrapy/unattended-pr-guard) or [vouch](https://github.com/mitchellh/vouch), labels such as `maybe-ai`, a PR creation cap |

Every verdict links to the file and line it is based on, pinned to the commit that was read.

**Site:** https://b84330808.github.io/ai-policy-map/ (search, filters, JSON and CSV download)

> [!IMPORTANT]
> Policies change, and keyword rules miss nuance. Always read the linked source before you contribute. "Not stated" means we found nothing we recognise; it does not mean AI contributions are welcome.

## What the verdicts mean

- **Banned**: the project does not accept AI-generated contributions.
- **Human-written text only**: AI may help with code, but PR descriptions, issues or comments must be the contributor's own words.
- **Allowed with disclosure**: AI use is fine if you say so (a checkbox, a trailer such as `Assisted-by:`, a note in the PR).
- **Allowed**: AI use is accepted, sometimes with conditions such as "you must understand and test what you submit".
- **Needs review**: the rules matched something but could not settle on a verdict (for example a ban and a permission in the same file, or only "unreviewed AI output will be closed"). We do not guess.
- **Not stated**: nothing found in the files we read.

For agents, **forbidden** covers both an explicit rule ("we do not allow autonomous agents") and an AI ban, which implies it (the record says so in a note).

Each verdict also has a **status**: `auto` (keyword rules only), `reviewed` (set by hand after reading the cited text, recorded in [`data/reviews.json`](data/reviews.json) with the reviewer and date), or `review_stale` (reviewed, but the cited file has changed since; the next review pass picks it up).

## How it works

1. **Repo list.** [`data/seed.txt`](data/seed.txt) holds hand-picked repos: ones with known AI rules (`[leads]`, always kept) and widely used projects (`[popular]`). `npm run discover` adds the most-starred repos in 20 languages, drops repos under 1,000 stars, archives, forks, and lists or tutorials, and writes [`data/repos.txt`](data/repos.txt) (about 340 repos).
2. **Crawl.** `npm run collect` uses the GitHub GraphQL API with your `gh` login (or `GITHUB_TOKEN` in Actions). Per repo, one query returns metadata, `pullRequestCreationPolicy`, listings of the root, `.github`, `.github/workflows`, `docs` and `doc`, labels, and the check names on the last few PRs. A second pass reads the candidate files at that exact commit:
   - `CONTRIBUTING*`, `HACKING*`, `DEVELOPMENT*`, `GOVERNANCE*` and files in `docs/contributing/` and similar folders
   - dedicated policy files: `AI_POLICY.md`, `AI.md`, `LLM_POLICY.md`, ...
   - agent instructions: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, ...
   - pull request templates, the README, and workflow files
   - the organisation's `.github` repo: its AI policy files always, its CONTRIBUTING and PR template only when the repo has none (GitHub's own fallback rule)
   - extra sources listed in [`data/extra-sources.json`](data/extra-sources.json), including files in another repo (`"owner/name:path"`)
3. **Rules.** [`src/rules.ts`](src/rules.ts) splits each file into sentences (keeping line numbers) and tags the ones that talk about AI as an authoring tool: ban, conditional ban, human-written text, disclosure, permission, agent rules. Separate rules find CLA, DCO, issue-first and assignment wording. Workflows are scanned for known actions and names; labels and check names for AI-related ones. [`src/classify.ts`](src/classify.ts) combines the tags; conflicts become **needs review**. Mentions of AI in repos whose subject is AI are ignored unless they match a rule.
4. **Reviews.** Entries in `data/reviews.json` override a verdict. Each one cites a file and line and stores the file's blob id, so a changed file marks the review stale instead of silently keeping an old answer. Every review records who made it (`by`). The first pass (2026-10-26, `by: "claude-code"`) was done with Claude Code reading each cited file in full; corrections from people are very welcome.
5. **Output.** `data/policies.json`, `data/policies.csv` and `data/meta.json`. The site in [`site/`](site/) is plain HTML and JavaScript and loads the JSON.

**Rate limits.** One GraphQL query per repo (plus batched file reads), at most four in flight, a 400 ms gap between requests, and a pause until the reset time when the remaining budget gets low. GraphQL has no ETags, so file texts are cached per commit SHA in `.cache/snapshots/`: a repo whose default branch has not moved costs one query. The weekly Action keeps that cache between runs.

## Limits

- Only the files listed above are read. Policies on websites, wikis, discussions or mailing lists are missed unless added to `extra-sources.json`.
- Keyword rules are English-only and literal. A policy phrased in an unusual way may be missed or misread; that is what **needs review** and the correction process are for.
- Anti-automation detection is name-based (known actions, workflow names, labels, check names on the last three PRs). A bot run from a private service is invisible.
- Only the first 100 labels plus AI-named labels are checked.
- Only the default branch is read, as of the `checked` date.
- Quotes are capped at 160 characters and stay under their repository's license.

## Corrections

Maintainers and anyone else: [open a correction request](https://github.com/b84330808/ai-policy-map/issues/new?template=correction.yml) with a link to the source. You can also send a pull request that adds an entry to `data/reviews.json`:

```json
"owner/name": {
  "ai_policy": {
    "verdict": "allowed_with_disclosure",
    "source": { "path": "CONTRIBUTING.md", "line": 42 },
    "note": "Disclose the tool in the PR description.",
    "reviewed": "2026-10-26",
    "by": "your-github-handle"
  }
}
```

The most durable fix is a clear sentence in your own CONTRIBUTING.md or an `AI_POLICY.md`: the next weekly crawl picks it up. To have a repo added or removed, edit `data/seed.txt` or `data/exclude.txt`.

## Data format

`data/policies.json` is an array with one object per repo. The main fields:

```jsonc
{
  "repo": "owner/name", "stars": 12345, "language": "Rust", "checked": "2026-10-26", "commit": "<sha>",
  "ai_policy":  { "value": "banned", "status": "auto", "quote": "…", "evidence": [{ "path": "CONTRIBUTING.md", "line": 3, "url": "https://github.com/…#L3", "quote": "…" }], "note": "…" },
  "agent_prs":  { "value": "forbidden", "status": "auto", "quote": "…", "evidence": [ … ] },
  "issue_first": { "value": "for_larger_changes", "status": "auto", … },
  "cla": { "value": true, "evidence": [ … ] }, "dco": { "value": null, "evidence": [] },
  "assignment_required": { "value": null, "evidence": [] },
  "outside_prs": { "value": "open", "evidence": [] }, "pr_creation_policy": "all",
  "anti_automation": [{ "kind": "workflow", "name": "matteogabriele/agentscan-action", "url": "…" }],
  "agent_files": ["AGENTS.md"], "sources": [{ "path": "CONTRIBUTING.md", "kind": "contributing", "scope": "repo", "url": "…" }]
}
```

`data/policies.csv` has one row per repo with the verdicts, the first source link and the quote.

## Run it yourself

Requires Node.js 24 (it runs the TypeScript sources directly) and a GitHub login (`gh auth login`, or `GITHUB_TOKEN`).

```sh
npm ci
npm run discover   # optional: rebuild data/repos.txt from data/seed.txt
npm run collect    # crawl; add --only owner/name,owner/name to update a few repos
npm run validate
npm test
npm run build      # writes _site/; serve it with any static server
```

A [weekly workflow](.github/workflows/refresh.yml) runs the crawl and opens a pull request titled "Weekly data refresh" on this repository, with the verdict changes in the description. Nothing is merged automatically.

## License

Code: [MIT](LICENSE). Data: [CC BY 4.0](data/LICENSE). By Wei-Lun Li. The collector and site were written with Claude Code.
