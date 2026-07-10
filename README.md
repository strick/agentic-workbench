# Agentic Workbench

A **portable, local-first agentic workbench / control plane** for the work you already do
with markdown notes, reusable `.copilot/skills`, Obsidian, Claude CLI, GitHub Copilot CLI,
and weekly reporting.

It is **not** a replacement operating system. It manages the flow:

> dictated notes → daily work log → weekly director report → sanitized wiki/canon source

- **Local-first**: no cloud dependency, no auth, everything on your disk.
- **Portable**: commit this repo to GitHub, clone on any machine (including a locked-down
  work PC), point it at that machine's folders via local config.
- **Non-invasive**: reads your existing `.copilot/skills` and Obsidian folders; only writes
  markdown drafts into the output folders you configure (or its own `./data` fallback).
- **Nothing private in Git**: notes, generated reports, run logs, local paths, and databases
  are all gitignored.

## Requirements

- **Node.js 24 or higher** (Node 24 LTS recommended; enforced at startup and via
  `package.json` engines). The app runs TypeScript natively and uses the built-in
  `node:sqlite` — no build step, no native modules.
- Check with `node --version`; install/upgrade via <https://nodejs.org>, `winget install
  OpenJS.NodeJS.LTS`, or nvm if the machine is on an older version.

## Quick start (any machine)

```bash
git clone <your-repo-url> agentic-workbench
cd agentic-workbench
npm install          # installs zod (the only runtime dependency)
npm run dev          # starts http://127.0.0.1:3220
```

Open <http://127.0.0.1:3220>. On first run everything works immediately against local
fallback folders under `./data` using the bundled example skills and the deterministic
**mock provider** — no AI installation required.

## Run with Docker

```bash
docker compose up --build     # http://localhost:3220
docker compose down           # stop
```

The image runs on Node 24 (native TypeScript execution + built-in `node:sqlite`) as an
unprivileged user. App state persists in the `workbench-data` named volume, so rebuilds
keep your metadata and fallback output. Change the published port with
`WORKBENCH_PORT=8080 docker compose up`.

To use your real skills / Obsidian vault / git repo instead of the bundled examples,
uncomment the `volumes` mounts and matching `WORKBENCH_*` env vars in
[`docker-compose.yml`](docker-compose.yml). Or run the image directly:

```bash
docker build -t agentic-workbench .
docker run -p 3220:3220 -v workbench-data:/app/data agentic-workbench
```

## Configuration

Two gitignored layers (Settings-page values win):

1. **`local-config.json`** — written by the **Settings** page in the UI. Preferred.
2. **`.env.local`** — copy from [.env.example](.env.example) if you prefer env vars.

| Setting | Env var | Meaning |
|---|---|---|
| Skills directory | `WORKBENCH_SKILLS_DIR` | Your existing `.copilot/skills` folder. Blank = auto-detect `./.copilot/skills`, then `~/.copilot/skills`, then `./skills`. |
| Obsidian vault root | `WORKBENCH_OBSIDIAN_VAULT_DIR` | Vault root (read-only reference in MVP). |
| Daily log folder | `WORKBENCH_DAILY_LOG_DIR` | Where daily work logs are written. Blank = `./data/daily-logs`. |
| Weekly report folder | `WORKBENCH_WEEKLY_REPORT_DIR` | Where weekly reports are written. Blank = `./data/weekly-reports`. |
| Wiki source folder | `WORKBENCH_WIKI_SOURCE_DIR` | Where sanitized wiki source notes are written. Blank = `./data/wiki-source`. |
| App data folder | `WORKBENCH_DATA_DIR` | SQLite DB, inbox notes, fallback outputs. Default `./data`. |
| Default provider | `WORKBENCH_DEFAULT_PROVIDER` | `mock` (default), `claude-cli`, `copilot-cli`. |
| Claude CLI | `CLAUDE_CLI_PATH` | Command name or full path. Health-checked; execution stubbed in MVP. |
| Copilot CLI | `COPILOT_CLI_PATH` | Command name or full path. Health-checked; execution stubbed in MVP. |
| Port / host | `WORKBENCH_PORT` / `WORKBENCH_HOST` | Default `3220` / `127.0.0.1` (3000 is often taken by Docker). |

### Pointing at your `.copilot/skills`

Open **Settings**, paste the folder path (e.g. `C:\Users\<you>\.copilot\skills`), click
**Validate paths**, then **Save local config**. The **Skills** page will list every `.md`
file found (recursively, including the `skills/<name>/SKILL.md` convention). YAML front
matter is parsed when present; otherwise the filename becomes the skill name and the whole
file is the skill content. Each skill shows its file path and content hash.

### Pointing at your Obsidian vault / work notes

Example mapping (adjust to your machine — these are placeholders, nothing is hardcoded):

| Setting | Example |
|---|---|
| Obsidian vault root | `C:\Users\<you>\Documents\Obsidian Notes\Personal\Work` |
| Daily log folder | `C:\Users\<you>\Documents\Obsidian Notes\Personal\Work\Daily` |
| Weekly report folder | `C:\Users\<you>\Documents\Obsidian Notes\Personal\Work\Reports` |
| Wiki source folder | `...\Work\Projects\ai-platform-canon\inbox` |

Each path is validated and shown as **writable / read-only / missing / unreadable /
not-configured**. A missing path never crashes the app — outputs just fall back to `./data`.

## Project Profiles

The **Profiles** page manages named bundles of machine-local settings — e.g.
*Work Notes*, *AI Architecture*, *Fable*, *Book*, *Zaxis*, *Grocery/Hermes*,
*Trading Coach* (seedable examples). Each profile can set:

- `skillsDir`, vault root, output folders, `gitRepoDir` (blank = inherit Settings)
- `defaultProvider`
- `allowedWorkflows` — the only workflows runnable while the profile is active
  (enforced in the API, not just hidden in the UI)
- `approvalActions` — which approval-gated actions the profile may propose

Profiles live in `local-config.json` (gitignored), so the same repo clone
carries different profiles on the personal PC and the work PC without
hardcoding paths. The active profile's overrides win over Settings; deactivate
to fall back to base config.

## Work PC setup

1. Clone the repo (only source, docs, and examples come across — no notes, no paths).
2. Confirm `node --version` reports 24+ (the app refuses to start otherwise).
3. `npm install && npm run dev`.
4. Open Settings, paste that machine's paths, validate, save.
5. Done — config stays in `local-config.json` on that machine and never syncs through Git.

## What must never be committed

`.gitignore` already covers all of it: `.env.local`, `local-config.json`, `/data/`
(inbox notes, fallback outputs, SQLite DB), `/runs/`, `/artifacts/`, and any `*.db|sqlite*`
files. `examples/` **is** committed on purpose. Before pushing, `git status` should show
only source/docs changes.

## Workflows

Every workflow is the same general model:

> **Skill + Input Source + Provider + Output Type + Destination + Approval Rule**

The **Workflows** page lists the built-in templates; each opens a run page whose
input controls (paste box, source-file picker, date/week label) are derived from
the template's input source. Built-in templates:

| Workflow | Input | Output |
|---|---|---|
| Daily Work Log | dictated notes | structured daily markdown |
| Weekly Director Report | daily logs | director-ready summary |
| Wiki Source Builder | logs + reports | sanitized wiki source note |
| Architecture Canon Update | work logs + architecture notes | sanitized canon note |
| ADR Generator | rough decision notes | formal ADR |
| Review Board Packet | architecture docs | decision packet |
| Sprint Planning Prep | notes + backlog | planning brief |
| 1:1 Prep | recent work + blockers | talking points |
| Fable Output QA | AI-generated docs | critique + improvement plan |

Outputs for the original three types go to their configured folders; the newer
types write to subfolders of `./data` (e.g. `data/adrs`). Legacy URLs
(`/inbox`, `/weekly`, `/wiki`) redirect to the corresponding workflow page.

Every run records: run id, skill id/path/content-hash, provider, input source, input
text/files, output artifact path, artifact type, status, timestamps, and errors. See the
**Runs** and **Artifacts** pages.

## Skill Lab

The **Skill Lab** page is the governance surface for your skills:

- **View all skills** with kind, source, and content hash.
- **Version history** — every distinct content hash is recorded with when it was first seen.
- **Test runs** — run a skill against pasted sample input; artifacts go to
  `data/lab-outputs`, never your real note folders.
- **Provider comparison** — check multiple providers and see outputs side by side.
- **Score outputs** — good / okay / bad per run.
- **Golden examples** — save a run's input/output pair (tied to the skill hash that
  produced it) as regression baseline material.
- **Preferred provider/model per skill** — saved and used as the Lab default.

## Architecture Mode

The **Architecture** page is the *AI Architecture Workbench* — a curated bundle
of the workflows an AI architect produces in a working week:

| Workflow | Output |
|---|---|
| Daily architecture log | structured log |
| Weekly AI architecture report | director-ready summary |
| Decision extractor | decisions made / needed, with owners |
| Risk extractor | risks, blockers, ownership gaps |
| ADR generator | formal architecture decision records |
| Review board packet | packet for architecture/security/executive review |
| Roadmap to backlog | epics / features / thin slices |
| Microsoft alignment review | Foundry / Copilot / APIM / MCP / Entra alignment |
| Talk track builder | short ready-to-say meeting language |
| Architecture canon update | sanitized canon note |

Each has a bundled example skill (frontmatter `kind:` matches it to the
workflow); your own skills of the same kind are preferred automatically.

## Morning Brief / background mode

```bash
npm run brief   # one-shot: print + write data/briefs/YYYY-MM-DD-brief.md
npm run watch   # background: regenerate the brief whenever notes change
```

The brief is a **local, read-only synthesis** — no AI provider involved:

| Brief section | Source |
|---|---|
| Yesterday | latest daily log (executive summary + work completed) |
| Today's focus | open follow-ups from recent logs |
| Waiting on | people/stakeholder lines + waiting/blocked/ping items |
| Architecture risks | risk sections + generated risk registers |
| Decisions needed | decision extractor outputs + ownership gaps |
| Draft standup line | composed from the above |

Also available in the UI at **Brief** (view latest / generate fresh). The only
write is the brief file itself; deliberately no email/calendar integration yet.

## Evals

The **Evals** page runs fixture-based checks against a skill + provider. Suites
live in `examples/evals/<name>/` (add private ones under `data/evals/<name>/`):

```
examples/evals/
  daily-log/
    eval.json      # required sections, leakage patterns, tone patterns, threshold
    input-001.md   # one case per input file
    case-001.json  # optional per-case checks (mustContain, extra forbidden patterns)
    rubric.md      # the human rubric (shown, not executed)
```

| Check | What it verifies |
|---|---|
| required-sections | the output has the structure the skill promises |
| no-private-leakage | configured names/costs/HR patterns never appear |
| source-traceability | output bullets are grounded in the source notes |
| tone | task-log tells ("todo", bug-by-bug bullets) stay out of director-facing docs |
| action-extraction | expected decisions/blockers/claims survive into the output |
| regression-diff | output compared (hash + line similarity) with the previous eval of the same suite/case/skill/provider |

Checks are deterministic — no LLM judges. Each case is a real provider run with
full provenance; results are stored in `eval_runs` with the skill hash, so you
can see exactly which prompt version regressed.

## Provider Shootout

The **Shootout** page runs the same input through the same skill on multiple
providers (mock / Claude CLI / Copilot CLI) and shows a comparison table —
time, status, output length, cost, score, artifact — plus the full outputs side
by side. Past shootouts are kept and re-viewable. Use it to learn which model is
worth spending on for which task. Artifacts land in `data/shootouts`.

## Providers

- **mock** — always available, deterministic, offline. Remains the default.
- **claude-cli** — real execution: `claude -p "<prompt>" --output-format text`
  (prompt via stdin for `.cmd` shims or prompts over 30 KB — `claude -p` reads stdin).
- **copilot-cli** — real execution: `copilot -p "<prompt>"` (its non-interactive mode).
  No `--allow-*` flags are ever passed, so Copilot cannot edit files or run commands.

Shared CLI rules: commands come from Settings (explicit path or PATH lookup, preferring
`.exe` over npm shims), are invoked with `execFile` — **never a shell** — with a **120 s
timeout** and an 8 MB output buffer (artifacts capped at 1 MB). The prompt is the skill
markdown + a delimited input block + an "output only the final markdown" instruction.
On failure, stderr is captured into the run's error field. Every run records the exact
command line minus the prompt body (e.g. `copilot.exe -p <prompt> --model claude-sonnet-4`).

Each run form has an optional **Model** field passed straight through as `--model`
(validated to `[A-Za-z0-9._:-]`, blank = provider default).

## Safety model

Draft-first outputs. No email, ADO, Teams, ServiceNow, or wiki writes. No file
deletion. No shell execution — only the configured provider CLIs via `execFile` (plus
`where`/`which` for health checks, and `git` for approval-gated commits), and Copilot
runs without any tool permissions. Automatic writes are hard-gated to the configured
output folders plus `./data` — anything else is refused. An `audit_events` table
records config changes, runs, artifact writes, and every approval decision.

### Approval-gated external writes

The one deliberate exception to draft-only:

> **The workbench may prepare actions. Humans approve writes.**

Two action types exist today, both proposed with a full preview and executed only
when you click **Approve** on the **Approvals** page:

| Action | Preview | On approval |
|---|---|---|
| Write to Obsidian vault | target path + content (or line diff vs the existing file) | file copied into the vault; existing files are never overwritten (numeric suffix) |
| Create Git commit | `git status --porcelain` + diff stats + exact message | `git add -A && git commit -m <msg>` in the configured repo — never a push |

Propose vault writes from the **Artifacts** page (→ Obsidian); propose commits from
the Approvals page. Rejecting discards the action; nothing is written. Every
proposal, decision, and execution result is stored and audited.

## Verify the MVP in 2 minutes

1. `npm run dev`, open <http://127.0.0.1:3220> — Dashboard shows path status + provider health.
2. **Inbox**: paste the contents of `examples/inbox/sample-dictated-note.md`, click
   **Run Daily Work Log** → artifact path + preview appear.
3. **Weekly Report**: the new log's week is pre-selected → **Generate Weekly Report**.
4. **Wiki Source**: tick the log + report → **Generate Wiki Source**.
5. **Runs** shows all three with skill hash + provider; **Artifacts** previews each file.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design details.
