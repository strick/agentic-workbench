// Fixture-based evals for skills. A suite lives in examples/evals/<id>/ (or
// <dataDir>/evals/<id>/ for private, machine-local suites):
//
//   eval.json      suite config: required sections, forbidden patterns, tone,
//                  traceability threshold, preferred skill kind
//   input-XXX.md   one eval case per input file
//   case-XXX.json  optional per-case overrides (mustContain, forbiddenPatterns)
//   rubric.md      human-readable rubric (displayed, not executed)
//
// Checks are deliberately simple and deterministic: structure, leakage,
// traceability, tone, action extraction, and regression against the previous
// eval of the same suite/case/skill/provider. No LLM-as-judge — the humans
// stay the judge; the evals catch drift and regressions mechanically.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { APP_ROOT, dataDir, type Config } from './config.ts';
import { findSkill } from './skills.ts';
import { runEvalCase } from './workflows.ts';
import { getStore, type EvalRunRecord } from './store.ts';

export type EvalSuiteConfig = {
  name: string;
  skillKind: string;
  requiredSections: string[];
  forbiddenPatterns: string[]; // regex source strings — privacy/leakage gate
  tonePatterns: string[]; // regex source strings that must NOT appear (task-log tells)
  traceabilityThreshold: number; // min fraction of output bullets grounded in the input
};

export type EvalCase = {
  id: string; // e.g. '001'
  inputPath: string;
  mustContain: string[]; // case-specific claims that must survive into the output
  forbiddenPatterns: string[]; // case-specific additions to the suite's list
};

export type EvalSuite = {
  id: string;
  dir: string;
  source: 'examples' | 'local';
  config: EvalSuiteConfig;
  cases: EvalCase[];
  rubric: string;
};

export type CheckResult = {
  check: string;
  status: 'pass' | 'fail' | 'skip' | 'info';
  detail: string;
};

export type CaseResult = {
  caseId: string;
  runId: string;
  status: 'completed' | 'error';
  error?: string;
  artifactPath?: string;
  outputHash?: string;
  checks: CheckResult[];
  passed: number;
  failed: number;
};

const DEFAULT_CONFIG: EvalSuiteConfig = {
  name: '',
  skillKind: '',
  requiredSections: [],
  forbiddenPatterns: [],
  tonePatterns: [],
  traceabilityThreshold: 0.4,
};

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function loadSuiteDir(dir: string, id: string, source: EvalSuite['source']): EvalSuite | null {
  const cfgRaw = readJson(path.join(dir, 'eval.json'));
  if (!cfgRaw) return null;
  const config: EvalSuiteConfig = {
    ...DEFAULT_CONFIG,
    name: String(cfgRaw.name ?? id),
    skillKind: String(cfgRaw.skillKind ?? ''),
    requiredSections: Array.isArray(cfgRaw.requiredSections) ? cfgRaw.requiredSections.map(String) : [],
    forbiddenPatterns: Array.isArray(cfgRaw.forbiddenPatterns) ? cfgRaw.forbiddenPatterns.map(String) : [],
    tonePatterns: Array.isArray(cfgRaw.tonePatterns) ? cfgRaw.tonePatterns.map(String) : [],
    traceabilityThreshold: Number(cfgRaw.traceabilityThreshold ?? DEFAULT_CONFIG.traceabilityThreshold),
  };
  const cases: EvalCase[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of entries.sort()) {
    const m = f.match(/^input-(\w+)\.md$/i);
    if (!m) continue;
    const caseCfg = readJson(path.join(dir, `case-${m[1]}.json`)) ?? {};
    cases.push({
      id: m[1],
      inputPath: path.join(dir, f),
      mustContain: Array.isArray(caseCfg.mustContain) ? caseCfg.mustContain.map(String) : [],
      forbiddenPatterns: Array.isArray(caseCfg.forbiddenPatterns) ? caseCfg.forbiddenPatterns.map(String) : [],
    });
  }
  if (!cases.length) return null;
  let rubric = '';
  try {
    rubric = fs.readFileSync(path.join(dir, 'rubric.md'), 'utf8');
  } catch {
    /* rubric optional */
  }
  return { id, dir, source, config, cases, rubric };
}

export function listEvalSuites(cfg: Config): EvalSuite[] {
  const roots: Array<{ root: string; source: EvalSuite['source'] }> = [
    { root: path.join(APP_ROOT, 'examples', 'evals'), source: 'examples' },
    { root: path.join(dataDir(cfg), 'evals'), source: 'local' },
  ];
  const suites: EvalSuite[] = [];
  for (const { root, source } of roots) {
    let dirs: fs.Dirent[] = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const suite = loadSuiteDir(path.join(root, d.name), d.name, source);
      if (suite) suites.push(suite);
    }
  }
  return suites;
}

export function getEvalSuite(cfg: Config, id: string): EvalSuite | null {
  return listEvalSuites(cfg).find((s) => s.id === id) ?? null;
}

// --- checks ---------------------------------------------------------------------

function headings(md: string): string[] {
  return md
    .split(/\r?\n/)
    .filter((l) => /^##\s+/.test(l))
    .map((l) => l.replace(/^##\s+/, '').trim().toLowerCase());
}

function checkSections(output: string, required: string[]): CheckResult {
  if (!required.length) return { check: 'required-sections', status: 'skip', detail: 'No required sections configured.' };
  const have = headings(output);
  const missing = required.filter((r) => !have.includes(r.toLowerCase()));
  return missing.length
    ? { check: 'required-sections', status: 'fail', detail: `Missing: ${missing.join(', ')}` }
    : { check: 'required-sections', status: 'pass', detail: `All ${required.length} sections present.` };
}

function checkForbidden(output: string, patterns: string[], label: string): CheckResult {
  if (!patterns.length) return { check: label, status: 'skip', detail: 'No patterns configured.' };
  const violations: string[] = [];
  for (const p of patterns) {
    try {
      const re = new RegExp(p, 'i');
      const m = output.match(re);
      if (m) violations.push(`${p} → "${m[0]}"`);
    } catch {
      violations.push(`(invalid regex: ${p})`);
    }
  }
  return violations.length
    ? { check: label, status: 'fail', detail: violations.join('; ') }
    : { check: label, status: 'pass', detail: `None of ${patterns.length} pattern(s) found.` };
}

const STOPWORDS = new Set(
  'the a an and or but of to in on for with at by from as is are was were be been it this that these those we i you they'.split(' '),
);

function significantTokens(line: string): Set<string> {
  return new Set(
    line
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 3 && !STOPWORDS.has(t)),
  );
}

/** Fraction of output bullet lines with >=2 significant tokens grounded in the input. */
function checkTraceability(output: string, input: string, threshold: number): CheckResult {
  const bullets = output
    .split(/\r?\n/)
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => l.replace(/^\s*-\s+/, ''))
    .filter((l) => l && !l.startsWith('_')); // skip placeholder bullets
  if (!bullets.length) return { check: 'source-traceability', status: 'skip', detail: 'No substantive bullets to trace.' };
  const inputTokens = significantTokens(input);
  let grounded = 0;
  for (const b of bullets) {
    const toks = [...significantTokens(b)];
    const hits = toks.filter((t) => inputTokens.has(t)).length;
    if (hits >= Math.min(2, toks.length)) grounded++;
  }
  const frac = grounded / bullets.length;
  const detail = `${grounded}/${bullets.length} bullets grounded in source (${(frac * 100).toFixed(0)}%, threshold ${(threshold * 100).toFixed(0)}%).`;
  return { check: 'source-traceability', status: frac >= threshold ? 'pass' : 'fail', detail };
}

function checkMustContain(output: string, claims: string[]): CheckResult {
  if (!claims.length) return { check: 'action-extraction', status: 'skip', detail: 'No expected claims configured for this case.' };
  const lower = output.toLowerCase();
  const missing = claims.filter((c) => !lower.includes(c.toLowerCase()));
  return missing.length
    ? { check: 'action-extraction', status: 'fail', detail: `Not found in output: ${missing.join(', ')}` }
    : { check: 'action-extraction', status: 'pass', detail: `All ${claims.length} expected item(s) present.` };
}

/** Line-level similarity (0..1) between two texts — for regression reporting. */
function lineSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const setB = new Set(b.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  if (!setA.size && !setB.size) return 1;
  let common = 0;
  for (const l of setA) if (setB.has(l)) common++;
  return (2 * common) / (setA.size + setB.size);
}

function checkRegression(output: string, outputHash: string, previous: EvalRunRecord | null, readPrev: () => string): CheckResult {
  if (!previous) return { check: 'regression-diff', status: 'info', detail: 'First eval for this suite/case/skill/provider — baseline recorded.' };
  if (previous.output_hash === outputHash) {
    return { check: 'regression-diff', status: 'pass', detail: 'Output byte-identical to previous eval.' };
  }
  const prevContent = readPrev();
  if (!prevContent) {
    return { check: 'regression-diff', status: 'info', detail: 'Output changed; previous artifact no longer readable for similarity.' };
  }
  const sim = lineSimilarity(prevContent, output);
  return {
    check: 'regression-diff',
    status: 'info',
    detail: `Output changed vs previous eval (${(sim * 100).toFixed(0)}% of lines shared). Review whether the change is an improvement.`,
  };
}

// --- runner ---------------------------------------------------------------------

export async function runEvalSuite(
  cfg: Config,
  args: { suiteId: string; skillId: string; providerId: string; model?: string },
): Promise<{ suite: string; results: CaseResult[] } | { error: string }> {
  const suite = getEvalSuite(cfg, args.suiteId);
  if (!suite) return { error: `Eval suite not found: ${args.suiteId}` };
  const skill = findSkill(cfg, args.skillId);
  if (!skill) return { error: `Skill not found: ${args.skillId}` };
  const store = getStore(dataDir(cfg));
  const results: CaseResult[] = [];

  for (const c of suite.cases) {
    let input = '';
    try {
      input = fs.readFileSync(c.inputPath, 'utf8');
    } catch {
      results.push({ caseId: c.id, runId: '', status: 'error', error: 'Input fixture unreadable.', checks: [], passed: 0, failed: 1 });
      continue;
    }
    const run = await runEvalCase(cfg, {
      skill,
      providerId: args.providerId,
      inputText: input,
      model: args.model,
      suiteId: suite.id,
      caseId: c.id,
    });
    if (run.status !== 'completed' || !run.artifactPath) {
      results.push({ caseId: c.id, runId: run.runId, status: 'error', error: run.error ?? 'Run failed.', checks: [], passed: 0, failed: 1 });
      continue;
    }
    let output = '';
    try {
      output = fs.readFileSync(run.artifactPath, 'utf8');
    } catch {
      results.push({ caseId: c.id, runId: run.runId, status: 'error', error: 'Artifact unreadable.', checks: [], passed: 0, failed: 1 });
      continue;
    }
    const outputHash = crypto.createHash('sha256').update(output).digest('hex');
    const previous = store.lastEvalRun(suite.id, c.id, skill.id, args.providerId);

    const checks: CheckResult[] = [
      checkSections(output, suite.config.requiredSections),
      checkForbidden(output, [...suite.config.forbiddenPatterns, ...c.forbiddenPatterns], 'no-private-leakage'),
      checkTraceability(output, input, suite.config.traceabilityThreshold),
      checkForbidden(output, suite.config.tonePatterns, 'tone'),
      checkMustContain(output, c.mustContain),
      checkRegression(output, outputHash, previous, () => {
        try {
          return previous?.artifact_path ? fs.readFileSync(previous.artifact_path, 'utf8') : '';
        } catch {
          return '';
        }
      }),
    ];
    const passed = checks.filter((ch) => ch.status === 'pass').length;
    const failed = checks.filter((ch) => ch.status === 'fail').length;
    store.addEvalRun({
      suite_id: suite.id,
      case_id: c.id,
      skill_id: skill.id,
      skill_hash: skill.hash,
      provider_id: args.providerId,
      model: args.model ?? '',
      run_id: run.runId,
      output_hash: outputHash,
      artifact_path: run.artifactPath,
      results: JSON.stringify(checks),
      passed,
      failed,
    });
    results.push({ caseId: c.id, runId: run.runId, status: 'completed', artifactPath: run.artifactPath, outputHash, checks, passed, failed });
  }

  store.audit('eval.suite_run', {
    suite: suite.id,
    skill: skill.name,
    provider: args.providerId,
    cases: results.length,
    failedChecks: results.reduce((n, r) => n + r.failed, 0),
  });
  return { suite: suite.id, results };
}
