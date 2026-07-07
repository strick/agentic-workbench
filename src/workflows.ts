import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir, type Config } from './config.ts';
import { listMarkdownFiles, safeWriteFile, workflowOutputDir } from './paths.ts';
import { findSkill, type Skill } from './skills.ts';
import { composePrompt, getProvider, type RunRequest } from './providers/index.ts';
import { getStore, type RunRecord } from './store.ts';
import { createRunStream } from './runStream.ts';
import { getWorkflow, workflowsByOutputType, type WorkflowDef } from './workflowDefs.ts';

export type WorkflowResult = {
  runId: string;
  status: 'completed' | 'error';
  artifactPath?: string;
  usedFallbackDir?: boolean;
  error?: string;
};

function executeWorkflow(args: {
  cfg: Config;
  def: WorkflowDef;
  skill: Skill;
  providerId: string;
  inputSource: string;
  inputText: string;
  inputFiles: Array<{ name: string; path: string; content: string }>;
  label: string;
  sourceRef: string;
  model?: string;
}): { runId: string; promise: Promise<WorkflowResult> } {
  const { cfg, def, skill, providerId } = args;
  const store = getStore(dataDir(cfg));
  const provider = getProvider(cfg, providerId);
  const runId = crypto.randomUUID();

  const stream = createRunStream(runId);
  const req: RunRequest = {
    skill,
    artifactType: def.outputType,
    inputText: args.inputText,
    inputFiles: args.inputFiles.map((f) => ({ name: f.name, content: f.content })),
    date: args.label,
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
    artifact_type: def.outputType,
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
  store.audit('run.started', { runId: run.id, workflow: def.id, skill: skill.name, provider: provider.id, artifactType: def.outputType });

  const filename = def.filenamePattern.replaceAll('{label}', args.label);
  const promise = provider
    .runSkill(req)
    .then((result) => {
      if (!result.ok) {
        store.failRun(run.id, result.error, result.commandLine);
        store.audit('run.failed', { runId: run.id, error: result.error, command: result.commandLine ?? '' });
        return { runId: run.id, status: 'error' as const, error: result.error };
      }
      const { dir, usedFallback } = workflowOutputDir(cfg, def.destination);
      const artifactPath = safeWriteFile(cfg, dir, filename, result.output);
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
        type: def.outputType,
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

// --- Source-file discovery ----------------------------------------------------
export type SourceFile = { name: string; path: string; type: string; date: string; week: string };

export function isoWeekOf(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) return '';
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * All directories where artifacts of an output type may live: every matching
 * workflow's configured destination plus its local data fallback.
 */
function outputDirsForType(cfg: Config, type: string): string[] {
  const dirs = new Set<string>();
  for (const def of workflowsByOutputType(type)) {
    const { dir } = workflowOutputDir(cfg, def.destination);
    dirs.add(dir);
    dirs.add(path.join(dataDir(cfg), def.destination.fallbackSubdir));
  }
  return [...dirs];
}

/** Markdown files of the given output types, deduplicated, newest name first. */
export function listSourceFiles(cfg: Config, types: string[]): SourceFile[] {
  const out: SourceFile[] = [];
  const seen = new Set<string>();
  for (const type of types) {
    for (const d of outputDirsForType(cfg, type)) {
      for (const f of listMarkdownFiles(d)) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        const m = f.name.match(/^(\d{4}-\d{2}-\d{2})/);
        const date = m ? m[1] : '';
        out.push({ name: f.name, path: f.path, type, date, week: date ? isoWeekOf(date) : '' });
      }
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export function listDailyLogs(cfg: Config): SourceFile[] {
  return listSourceFiles(cfg, ['daily-log']);
}

function readInputFiles(paths: string[], allowed: SourceFile[]) {
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

// --- Generic workflow runner ---------------------------------------------------
export type WorkflowRunArgs = {
  workflowId: string;
  skillId: string;
  providerId: string;
  noteText?: string;
  inboxFile?: string;
  files?: string[];
  /** Date (YYYY-MM-DD) or week (YYYY-Www) label; defaults derived when blank. */
  label?: string;
  model?: string;
};

type ResolvedInput = {
  def: WorkflowDef;
  skill: Skill;
  inputText: string;
  inputSource: string;
  sourceRef: string;
  inputFiles: Array<{ name: string; path: string; content: string }>;
  label: string;
};

function resolveWorkflowInput(cfg: Config, args: WorkflowRunArgs): ResolvedInput | { error: string } {
  const def = getWorkflow(args.workflowId);
  if (!def) return { error: `Unknown workflow: ${args.workflowId}` };
  const skill = findSkill(cfg, args.skillId);
  if (!skill) return { error: `Skill not found: ${args.skillId}` };

  const acceptsText = def.inputSource.kind === 'text' || def.inputSource.kind === 'text-or-files';
  const acceptsFiles = def.inputSource.kind === 'files' || def.inputSource.kind === 'text-or-files';

  let pastedText = acceptsText ? (args.noteText ?? '').trim() : '';
  let inputSource = 'pasted';
  let sourceRefParts: string[] = [];
  const inputFiles: Array<{ name: string; path: string; content: string }> = [];

  // Saved inbox note as the text input (daily-log style).
  if (acceptsText && !pastedText && args.inboxFile) {
    const inboxDir = path.join(dataDir(cfg), 'inbox');
    const target = path.resolve(inboxDir, path.basename(args.inboxFile));
    try {
      pastedText = fs.readFileSync(target, 'utf8').trim();
    } catch {
      return { error: `Inbox file not readable: ${args.inboxFile}` };
    }
    inputSource = 'inbox-file';
    sourceRefParts.push(`Inbox file: ${path.basename(target)}`);
    inputFiles.push({ name: path.basename(target), path: target, content: pastedText });
  } else if (pastedText) {
    sourceRefParts.push('Pasted notes');
  }

  if (acceptsFiles && args.files?.length) {
    const allowed = listSourceFiles(cfg, def.inputSource.fileTypes);
    const files = readInputFiles(args.files, allowed);
    inputFiles.push(...files);
    if (files.length) {
      inputSource = pastedText ? 'pasted+files' : 'source-files';
      sourceRefParts.push(`${files.length} source file(s)`);
    }
  }

  const fileBlock = inputFiles
    .filter((f) => f.content !== pastedText) // don't repeat an inbox note used as the text
    .map((f) => `<!-- ${f.name} -->\n${f.content}`)
    .join('\n\n');
  const inputText = [pastedText, fileBlock].filter(Boolean).join('\n\n');
  if (!inputText.trim()) {
    return { error: acceptsFiles ? 'No input provided — paste notes and/or select source files.' : 'No input notes provided.' };
  }

  let label = (args.label ?? '').trim();
  if (!label) {
    if (def.dateMode === 'week') {
      label =
        inputFiles.map((f) => f.name.match(/^(\d{4}-\d{2}-\d{2})/)?.[1]).filter(Boolean).map((d) => isoWeekOf(d!))[0] ||
        isoWeekOf(new Date().toISOString().slice(0, 10));
    } else {
      label = new Date().toISOString().slice(0, 10);
    }
  }

  return { def, skill, inputText, inputSource, sourceRef: sourceRefParts.join(' + ') || 'Direct input', inputFiles, label };
}

/**
 * Starts a workflow run without waiting for it to finish; the caller watches
 * the run's live stream / polls the run record for completion.
 */
export function startWorkflowRun(cfg: Config, args: WorkflowRunArgs): { runId: string } | { error: string } {
  const resolved = resolveWorkflowInput(cfg, args);
  if ('error' in resolved) return resolved;
  const { def, skill, inputText, inputSource, sourceRef, inputFiles, label } = resolved;
  const { runId } = executeWorkflow({
    cfg,
    def,
    skill,
    providerId: args.providerId,
    inputSource,
    inputText,
    inputFiles,
    label,
    sourceRef,
    model: args.model,
  });
  return { runId };
}

/** Runs a workflow to completion (used by non-interactive callers/tests). */
export async function runWorkflow(cfg: Config, args: WorkflowRunArgs): Promise<WorkflowResult | { error: string }> {
  const resolved = resolveWorkflowInput(cfg, args);
  if ('error' in resolved) return resolved;
  const { def, skill, inputText, inputSource, sourceRef, inputFiles, label } = resolved;
  return executeWorkflow({
    cfg,
    def,
    skill,
    providerId: args.providerId,
    inputSource,
    inputText,
    inputFiles,
    label,
    sourceRef,
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
