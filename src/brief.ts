// Morning Brief: a local, read-only synthesis of what's already on disk.
// No provider involved — deterministic extraction from daily logs, decision
// lists, and risk registers, so `npm run brief` works offline in <1s and can
// safely run in the background (`npm run watch`). The only write is the brief
// itself, into data/briefs.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, type Config } from './config.ts';
import { safeWriteFile } from './paths.ts';
import { extractSection } from './generate.ts';
import { listSourceFiles, type SourceFile } from './workflows.ts';
import { getStore } from './store.ts';

type Doc = { name: string; date: string; content: string };

function readDocs(files: SourceFile[], limit: number): Doc[] {
  const docs: Doc[] = [];
  for (const f of files.slice(0, limit)) {
    try {
      docs.push({ name: f.name, date: f.date, content: fs.readFileSync(f.path, 'utf8') });
    } catch {
      /* skip unreadable */
    }
  }
  return docs;
}

/** Prose of a `## Section` (non-bullet lines), for sections like Executive Summary. */
function sectionText(md: string, heading: string): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inSection = line.replace(/^##\s+/, '').trim().toLowerCase() === heading.toLowerCase();
      continue;
    }
    if (inSection && line.trim() && !/^\s*-\s+/.test(line) && !line.startsWith('#')) out.push(line.trim());
  }
  return out.join(' ');
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.map((i) => i.trim()).filter(Boolean))];
}

function bullets(items: string[], fallback: string): string {
  return items.length ? items.map((i) => `- ${i}`).join('\n') : `- _${fallback}_`;
}

const RE_WAITING = /\b(waiting (on|for)|blocked (on|by)|need(s)? .{0,30}\bfrom\b|ping|follow up with|escalate)\b/i;

export type Brief = { date: string; content: string; sources: string[] };

export function buildBrief(cfg: Config): Brief {
  const today = new Date().toISOString().slice(0, 10);
  const logs = readDocs(listSourceFiles(cfg, ['daily-log']), 5);
  const decisionDocs = readDocs(listSourceFiles(cfg, ['decision-list']), 3);
  const riskDocs = readDocs(listSourceFiles(cfg, ['risk-register']), 3);

  const latest = logs[0];
  const yesterdaySummary = latest ? sectionText(latest.content, 'Executive Summary') : '';
  const yesterdayWork = latest ? extractSection(latest.content, 'Work Completed') : [];

  const followups = dedupe(logs.flatMap((l) => extractSection(l.content, 'Follow-ups')));
  const people = dedupe(logs.flatMap((l) => extractSection(l.content, 'People / Stakeholders')));
  const risks = dedupe([
    ...logs.flatMap((l) => extractSection(l.content, 'Risks / Blockers')),
    ...riskDocs.flatMap((d) => [...extractSection(d.content, 'Blockers (active)'), ...extractSection(d.content, 'Risks')]),
  ]);
  const decisionsNeeded = dedupe([
    ...decisionDocs.flatMap((d) => extractSection(d.content, 'Decisions Needed')),
    ...logs.flatMap((l) => extractSection(l.content, 'Decisions Needed')),
  ]);
  const ownershipGaps = dedupe(riskDocs.flatMap((d) => extractSection(d.content, 'Ownership Gaps')));
  const waiting = dedupe([...followups, ...risks, ...people].filter((i) => RE_WAITING.test(i)));

  const clip = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);
  const standup = [
    `Yesterday: ${clip(yesterdayWork[0] ?? yesterdaySummary ?? 'no logged work')}`,
    `Today: ${clip(followups[0] ?? 'continue current threads')}`,
    `Blocked: ${clip(risks.find((r) => /block/i.test(r)) ?? 'nothing blocking')}`,
  ].join(' · ');

  const sources = [...logs, ...decisionDocs, ...riskDocs].map((d) => d.name);
  const content = [
    `# Morning Brief — ${today}`,
    '',
    '## Yesterday',
    latest ? `_${latest.name}_${yesterdaySummary ? ` — ${yesterdaySummary}` : ''}` : '_No daily logs found yet._',
    '',
    bullets(yesterdayWork, 'No work items extracted.'),
    '',
    "## Today's Focus",
    bullets(followups.slice(0, 10), 'No open follow-ups.'),
    '',
    '## Waiting On',
    bullets(waiting.slice(0, 10), 'Not waiting on anyone.'),
    '',
    '## Architecture Risks',
    bullets(risks.slice(0, 10), 'No active risks recorded.'),
    '',
    '## Decisions Needed',
    bullets([...decisionsNeeded, ...ownershipGaps].slice(0, 10), 'No open decisions recorded.'),
    '',
    '## Draft Standup Line',
    standup,
    '',
    '---',
    '',
    `> Generated locally by the workbench brief engine (read-only extraction, no AI provider) from: ${sources.join(', ') || 'no sources'}.`,
    '',
  ].join('\n');

  return { date: today, content, sources };
}

export function writeBrief(cfg: Config): { path: string; brief: Brief } {
  const brief = buildBrief(cfg);
  const dir = path.join(dataDir(cfg), 'briefs');
  const written = safeWriteFile(cfg, dir, `${brief.date}-brief.md`, brief.content);
  getStore(dataDir(cfg)).audit('brief.generated', { path: written, sources: brief.sources.length });
  return { path: written, brief };
}

export function latestBrief(cfg: Config): { name: string; path: string; content: string } | null {
  const dir = path.join(dataDir(cfg), 'briefs');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return null;
  }
  if (!files.length) return null;
  const name = files.sort().reverse()[0];
  const p = path.join(dir, name);
  try {
    return { name, path: p, content: fs.readFileSync(p, 'utf8') };
  } catch {
    return null;
  }
}

/** Directories worth watching for note changes (daily logs, configured + fallback). */
export function watchDirs(cfg: Config): string[] {
  const dirs = new Set<string>();
  for (const f of listSourceFiles(cfg, ['daily-log', 'decision-list', 'risk-register'])) {
    dirs.add(path.dirname(f.path));
  }
  dirs.add(path.join(dataDir(cfg), 'daily-logs'));
  return [...dirs].filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}
