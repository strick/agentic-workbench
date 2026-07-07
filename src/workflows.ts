import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, type Config } from './config.ts';
import { effectiveOutputDir, listMarkdownFiles, safeWriteFile } from './paths.ts';
import { findSkill, type Skill } from './skills.ts';
import { composePrompt, getProvider, type ArtifactType, type RunRequest } from './providers/index.ts';
import { getStore, type RunRecord } from './store.ts';
import { createRunStream } from './runStream.ts';

export type WorkflowResult = {
  runId: string;
  status: 'completed' | 'error';
  artifactPath?: string;
  usedFallbackDir?: boolean;
  error?: string;
};

const OUTPUT_DIR_KEY: Record<ArtifactType, 'dailyLogDir' | 'weeklyReportDir' | 'wikiSourceDir'> = {
  'daily-log': 'dailyLogDir',
  'weekly-report': 'weeklyReportDir',
  'wiki-source': 'wikiSourceDir',
};

function executeWorkflow(args: {
  cfg: Config;
  skill: Skill;
  providerId: string;
  artifactType: ArtifactType;
  inputSource: string;
  inputText: string;
  inputFiles: Array<{ name: string; path: string; content: string }>;
  date: string;
  filename: string;
  sourceRef: string;
  model?: string;
}): { runId: string; promise: Promise<WorkflowResult> } {
  const { cfg, skill, providerId, artifactType } = args;
  const store = getStore(dataDir(cfg));
  const provider = getProvider(cfg, providerId);
  const runId = crypto.randomUUID();

  const stream = createRunStream(runId);
  const req: RunRequest = {
    skill,
    artifactType,
    inputText: args.inputText,
    inputFiles: args.inputFiles.map((f) => ({ name: f.name, content: f.content })),
    date: args.date,
    sourceRef: args.sourceRef,
    options: { model: args.model || undefined },
    onChunk: (line) => stream.push(line),
  };
  const prompt = composePrompt(req);

  const run = store.createRun({
    id: runId,
    skill_id: skill.id,
    skill_name: skill.name,
    skill_path: skill.path,
    skill_hash: skill.hash,
    provider_id: provider.id,
    input_source: args.inputSource,
    input_text: args.inputText,
    input_files: args.inputFiles.map((f) => f.path),
    output_artifact_path: '',
    artifact_type: artifactType,
    status: 'running',
    error: '',
    provider_command: '',
    model_used: '',
    tokens_input: 0,
    tokens_output: 0,
    cost_usd: 0,
    credits_used: 0,
    prompt,
  });
  store.upsertSkillSighting(skill);
  store.audit('run.started', { runId: run.id, skill: skill.name, provider: provider.id, artifactType });

  const promise = provider
    .runSkill(req)
    .then((result) => {
      if (!result.ok) {
        store.failRun(run.id, result.error, result.commandLine);
        store.audit('run.failed', { runId: run.id, error: result.error, command: result.commandLine ?? '' });
        return { runId: run.id, status: 'error' as const, error: result.error };
      }
      const { dir, usedFallback } = effectiveOutputDir(cfg, OUTPUT_DIR_KEY[artifactType]);
      const artifactPath = safeWriteFile(cfg, dir, args.filename, result.output);
      store.completeRun(run.id, {
        output_artifact_path: artifactPath,
        provider_command: result.commandLine,
        model_used: result.usage?.model,
        tokens_input: result.usage?.tokensInput,
        tokens_output: result.usage?.tokensOutput,
        cost_usd: result.usage?.costUsd,
        credits_used: result.usage?.credits,
      });
      store.addArtifact({
        run_id: run.id,
        type: artifactType,
        path: artifactPath,
        title: path.basename(artifactPath),
      });
      store.audit('artifact.written', { runId: run.id, path: artifactPath, usedFallback });
      return { runId: run.id, status: 'completed' as const, artifactPath, usedFallbackDir: usedFallback };
    })
    .catch((err) => {
      const msg = (err as Error).message;
      store.failRun(run.id, msg);
      store.audit('run.failed', { runId: run.id, error: msg });
      return { runId: run.id, status: 'error' as const, error: msg };
    });

  promise.then((result) => stream.finish(result));

  return { runId: run.id, promise };
}

// --- Workflow 1: Daily Work Log --------------------------------------------
type DailyLogArgs = { noteText?: string; inboxFile?: string; skillId: string; date?: string };
type ResolvedDailyLogInput = {
  skill: Skill;
  inputText: string;
  inputSource: string;
  sourceRef: string;
  inputFiles: Array<{ name: string; path: string; content: string }>;
  date: string;
};

function resolveDailyLogInput(cfg: Config, args: DailyLogArgs): ResolvedDailyLogInput | { error: string } {
  const skill = findSkill(cfg, args.skillId);
  if (!skill) return { error: `Skill not found: ${args.skillId}` };
  let inputText = (args.noteText ?? '').trim();
  let inputSource = 'pasted';
  let sourceRef = 'Pasted dictated notes';
  const inputFiles: Array<{ name: string; path: string; content: string }> = [];
  if (!inputText && args.inboxFile) {
    const inboxDir = path.join(dataDir(cfg), 'inbox');
    const target = path.resolve(inboxDir, path.basename(args.inboxFile));
    try {
      inputText = fs.readFileSync(target, 'utf8').trim();
    } catch {
      return { error: `Inbox file not readable: ${args.inboxFile}` };
    }
    inputSource = 'inbox-file';
    sourceRef = `Inbox file: ${path.basename(target)}`;
    inputFiles.push({ name: path.basename(target), path: target, content: inputText });
  }
  if (!inputText) return { error: 'No input notes provided.' };
  const date = args.date || new Date().toISOString().slice(0, 10);
  return { skill, inputText, inputSource, sourceRef, inputFiles, date };
}

export async function runDailyLog(
  cfg: Config,
  args: { noteText?: string; inboxFile?: string; skillId: string; providerId: string; date?: string; model?: string },
): Promise<WorkflowResult | { error: string }> {
  const resolved = resolveDailyLogInput(cfg, args);
  if ('error' in resolved) return resolved;
  const { skill, inputText, inputSource, sourceRef, inputFiles, date } = resolved;
  return executeWorkflow({
    cfg,
    skill,
    providerId: args.providerId,
    artifactType: 'daily-log',
    inputSource,
    inputText,
    inputFiles,
    date,
    filename: `${date}-daily-log.md`,
    sourceRef,
    model: args.model,
  }).promise;
}

/** Starts a daily-log run without waiting for it to finish; the caller watches the run's live stream / polls the run record for completion. */
export function startDailyLog(
  cfg: Config,
  args: { noteText?: string; inboxFile?: string; skillId: string; providerId: string; date?: string; model?: string },
): { runId: string } | { error: string } {
  const resolved = resolveDailyLogInput(cfg, args);
  if ('error' in resolved) return resolved;
  const { skill, inputText, inputSource, sourceRef, inputFiles, date } = resolved;
  const { runId } = executeWorkflow({
    cfg,
    skill,
    providerId: args.providerId,
    artifactType: 'daily-log',
    inputSource,
    inputText,
    inputFiles,
    date,
    filename: `${date}-daily-log.md`,
    sourceRef,
    model: args.model,
  });
  return { runId };
}

// --- Daily-log discovery / week grouping ------------------------------------
export type DailyLogFile = { name: string; path: string; date: string; week: string };

export function isoWeekOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return '';
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Daily logs from both the configured dir and the local fallback dir. */
export function listDailyLogs(cfg: Config): DailyLogFile[] {
  const dirs = new Set<string>();
  const { dir } = effectiveOutputDir(cfg, 'dailyLogDir');
  dirs.add(dir);
  dirs.add(path.join(dataDir(cfg), 'daily-logs'));
  const out: DailyLogFile[] = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    for (const f of listMarkdownFiles(d)) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      const m = f.name.match(/^(\d{4}-\d{2}-\d{2})/);
      const date = m ? m[1] : '';
      out.push({ name: f.name, path: f.path, date, week: date ? isoWeekOf(date) : '' });
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export function listWeeklyReports(cfg: Config): Array<{ name: string; path: string }> {
  const dirs = new Set<string>();
  dirs.add(effectiveOutputDir(cfg, 'weeklyReportDir').dir);
  dirs.add(path.join(dataDir(cfg), 'weekly-reports'));
  const out: Array<{ name: string; path: string }> = [];
  const seen = new Set<string>();
  for (const d of dirs) {
    for (const f of listMarkdownFiles(d)) {
      if (!seen.has(f.path)) {
        seen.add(f.path);
        out.push({ name: f.name, path: f.path });
      }
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

function readInputFiles(paths: string[], allowed: DailyLogFile[] | Array<{ name: string; path: string }>) {
  const allowedMap = new Map(allowed.map((f) => [f.path, f.name]));
  const files: Array<{ name: string; path: string; content: string }> = [];
  for (const p of paths) {
    const name = allowedMap.get(p);
    if (!name) continue; // only files the app itself listed may be read
    try {
      files.push({ name, path: p, content: fs.readFileSync(p, 'utf8') });
    } catch {
      /* skip unreadable */
    }
  }
  return files;
}

// --- Workflow 2: Weekly Director Report ------------------------------------
export async function runWeeklyReport(
  cfg: Config,
  args: { week: string; files: string[]; skillId: string; providerId: string; model?: string },
): Promise<WorkflowResult | { error: string }> {
  const skill = findSkill(cfg, args.skillId);
  if (!skill) return { error: `Skill not found: ${args.skillId}` };
  const files = readInputFiles(args.files, listDailyLogs(cfg));
  if (!files.length) return { error: 'No readable daily logs selected.' };
  const week = args.week || files.map((f) => f.name.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]).filter(Boolean).map((d) => isoWeekOf(d!))[0] || 'unknown-week';
  return executeWorkflow({
    cfg,
    skill,
    providerId: args.providerId,
    artifactType: 'weekly-report',
    inputSource: 'daily-logs',
    inputText: files.map((f) => `<!-- ${f.name} -->\n${f.content}`).join('\n\n'),
    inputFiles: files,
    date: week,
    filename: `${week}-weekly-report.md`,
    sourceRef: `${files.length} daily logs`,
    model: args.model,
  }).promise;
}

// --- Workflow 3: Wiki Source Builder ----------------------------------------
export async function runWikiSource(
  cfg: Config,
  args: { files: string[]; skillId: string; providerId: string; date?: string; model?: string },
): Promise<WorkflowResult | { error: string }> {
  const skill = findSkill(cfg, args.skillId);
  if (!skill) return { error: `Skill not found: ${args.skillId}` };
  const candidates = [...listDailyLogs(cfg), ...listWeeklyReports(cfg)];
  const files = readInputFiles(args.files, candidates);
  if (!files.length) return { error: 'No readable source notes selected.' };
  const date = args.date || new Date().toISOString().slice(0, 10);
  return executeWorkflow({
    cfg,
    skill,
    providerId: args.providerId,
    artifactType: 'wiki-source',
    inputSource: 'logs-and-reports',
    inputText: files.map((f) => `<!-- ${f.name} -->\n${f.content}`).join('\n\n'),
    inputFiles: files,
    date,
    filename: `${date}-wiki-source.md`,
    sourceRef: `${files.length} source notes`,
    model: args.model,
  }).promise;
}

// --- Inbox -------------------------------------------------------------------
export function saveInboxNote(cfg: Config, text: string): { path: string; name: string } {
  const inboxDir = path.join(dataDir(cfg), 'inbox');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const finalPath = safeWriteFile(cfg, inboxDir, `${stamp}-dictated-note.md`, text.trim() + '\n');
  const store = getStore(dataDir(cfg));
  store.audit('inbox.saved', { path: finalPath });
  return { path: finalPath, name: path.basename(finalPath) };
}

export function listInboxNotes(cfg: Config): Array<{ name: string; path: string }> {
  return listMarkdownFiles(path.join(dataDir(cfg), 'inbox')).map((f) => ({ name: f.name, path: f.path }));
}

export function runToJson(run: RunRecord) {
  return { ...run, shortId: run.id.slice(0, 8) };
}
