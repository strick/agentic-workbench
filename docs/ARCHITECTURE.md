# Agentic Workbench — Architecture

## Positioning

A local-first **control plane** over an existing markdown workflow. The workbench owns
orchestration, run tracking, and safety; the *content intelligence* is delegated to
pluggable **agent providers** (mock today; Claude CLI / Copilot CLI adapters next).
Skills remain plain markdown files in the user's existing `.copilot/skills` folder —
the workbench reads them, hashes them, and passes them to providers; it never forks them
into a private skill format.

## Stack

- **Runtime**: Node ≥ 24 (enforced by a startup guard and `package.json` engines),
  TypeScript executed natively (erasable-syntax only, `.ts` import specifiers).
- **Server**: `node:http` with a small route table. Server-rendered HTML pages
  (template literals) + a thin JSON API. No frontend framework — keeps the clone-and-run
  footprint at exactly one npm dependency (`zod`).
- **Metadata**: `node:sqlite` (`data/workbench.db`) — built into Node 24, so it is always
  available. A JSON-file store (`data/workbench-meta.json`) remains in `store.ts` purely
  as defense-in-depth behind the same interface.
- **Content**: plain markdown files on disk — skills are read in place; artifacts are
  written to configured output folders.

## Module map

```
src/
  config.ts          config layers (.env.local + local-config.json), zod schema, precedence
  paths.ts           path validation, fallback dirs, allowed read/write roots, safeWriteFile
  store.ts           SQLite/JSON metadata store: runs, artifacts, skills, audit, approvals
  skills.ts          recursive skill scan, tolerant frontmatter parse, sha256 content hash
  generate.ts        deterministic markdown generators (mock provider's engine)
  providers/index.ts AgentProvider interface, MockProvider, ClaudeCli/CopilotCli stubs
  workflows.ts       daily-log / weekly-report / wiki-source orchestration + run records
  ui.ts              layout, pages (dashboard, settings, skills, inbox, weekly, wiki, runs, artifacts)
  server.ts          http plumbing, routes, JSON API, error handling
```

## Config precedence

`local-config.json` (written by the Settings UI) → `.env.local` / `process.env` →
schema defaults. Config is re-read per request, so saving settings applies immediately.
Bad values are dropped individually — a corrupt config never prevents startup.

## Core entities

| Entity | Where | Notes |
|---|---|---|
| Skill / SkillVersion | filesystem is source of truth; sightings + hash history in DB | id = hash(source+path); version = distinct content hash |
| AgentProvider | code + health snapshots in DB | `mock`, `claude-cli`, `copilot-cli` |
| Run | DB | full provenance: skill path + hash, provider, input, output, status, timestamps, error |
| Artifact | DB + markdown file | type: daily-log / weekly-report / wiki-source |
| ConfigPath | DB snapshot of last validation | status: writable / read-only / missing / unreadable / not-configured |
| Approval | DB table (placeholder) | reserved for future external writes (wiki/Git/email) — nothing in MVP needs approval because nothing external is written |
| AuditEvent | DB | server start, config saves, run lifecycle, artifact writes |

## Provider contract

```ts
interface AgentProvider {
  id: 'mock' | 'claude-cli' | 'copilot-cli';
  name: string;
  capabilities: string[];
  healthCheck(): Promise<{ healthy: boolean; detail: string; command?: string }>;
  runSkill(req: RunRequest): Promise<{ ok: true; output: string } | { ok: false; error: string }>;
  summarizeRun(runId: string, store: Store): Promise<string>;
}
```

`RunRequest` carries the **skill** (full markdown + hash), the **artifact type**, the
**input text/files**, a date/week label, and per-run **provider options** (`model`).
Orchestration, artifact writing, and run tracking live in `workflows.ts` regardless of
provider — providers only turn a request into markdown.

- **MockProvider** — deterministic keyword-based extractors in `generate.ts`. Same input
  + same skill ⇒ byte-identical output. Default provider; keeps everything offline-testable.
- **ClaudeCliProvider / CopilotCliProvider** — real execution via `execFile` (never a
  shell). Prompt = `skill.raw` + delimited input block + "output only the final markdown
  document" instruction. Claude: `claude -p "<prompt>" --output-format text [--model m]`;
  Copilot: `copilot -p "<prompt>" [--model m]` with no `--allow-*` flags (no tool access).
  - **Prompt transport**: inline argv when the command is a real executable and the
    prompt is < 30 KB (Windows command-line limit); via **stdin** for `.cmd`/`.bat` shims
    (run under `cmd.exe /d /s /c` with fixed, regex-validated flags only — the prompt
    never touches the cmd.exe command line) or oversized prompts. Copilot has no stdin
    prompt mode, so shim/oversized cases fail with guidance to configure the `.exe` path.
  - **Limits**: 120 s timeout, 8 MB exec buffer, 1 MB artifact cap (truncation marker).
  - **Provenance**: the exact command line minus the prompt body is stored on the run
    (`provider_command`, e.g. `copilot.exe -p <prompt> --model claude-sonnet-4`); stderr
    (ANSI-stripped, last 800 chars) is captured into the run's error field on failure.
  - PATH lookup prefers `.exe` over npm's extensionless/`.cmd` shims.

## Safety model

- **Write gate**: `safeWriteFile` refuses any target outside `allowedWriteRoots` =
  configured output dirs + `./data`. Filenames are sanitized; existing files are never
  overwritten (suffix de-dup) or deleted.
- **Read gate**: preview/read endpoints only serve files under `allowedReadRoots` =
  skills dir, examples, vault, output dirs, data dir. Workflow inputs are further limited
  to files the app itself enumerated.
- **No external effects**: no email/ADO/Teams/ServiceNow/wiki/Git writes. The only
  subprocesses ever spawned are the configured provider CLIs (via `execFile`, no shell)
  and `where`/`which` health checks; Copilot gets no tool permissions. The `approvals`
  table exists so future external writes can be gated explicitly.
- **Git hygiene**: `.gitignore` excludes `.env.local`, `local-config.json`, `/data/`,
  `/runs/`, `/artifacts/`, `*.db|sqlite*`. Machine paths live only in local config.

## Portability decisions

- One runtime dependency (zod): survives locked-down corporate npm registries.
- No native modules: `node:sqlite` is built into Node 24+, which the app requires.
- All app-relative paths resolve against the repo root (`import.meta.dirname/..`),
  never `process.cwd()`, so the server can be launched from anywhere.
- Default port 3220 (3000 is commonly occupied), overridable via config.

## Possible next milestones

1. Streaming run output to the UI (progress instead of a spinner for 120 s runs).
2. Per-provider defaults in Settings (model, extra flags) on top of the per-run field.
3. Side-by-side provider comparison for the same input (mock vs claude vs copilot).
4. Approval-gated external writes (wiki/Git) using the existing `approvals` table.
