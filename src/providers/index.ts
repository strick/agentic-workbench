import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { APP_ROOT, resolveConfigPath, type Config, type ProviderId } from '../config.ts';
import type { Skill } from '../skills.ts';
import type { Store } from '../store.ts';
import { genDailyLog, genGeneric, genWeeklyReport, genWikiSource } from '../generate.ts';

/** Open set of workflow output types ('daily-log', 'adr', 'review-packet', ...). */
export type ArtifactType = string;

/** GitHub Copilot "premium request" credit price: $100 buys 10,000 credits. */
const USD_PER_CREDIT = 0.01;

/**
 * Debug-only: persists the FULL, unfiltered raw stdout of every CLI provider
 * run to disk (bounded to the last N files per provider). This exists
 * because our cost/token estimator only recognizes a fixed allow-list of
 * JSONL event types (see CopilotCliProvider.parseOutput) — any event type it
 * doesn't recognize (e.g. tool-call/tool-result events on multi-turn/agentic
 * runs) is silently invisible to both the estimator AND the live-run pane.
 * Without this capture, diagnosing "what event types are we missing" would
 * require spending fresh real credits on every investigation. Files land
 * under data/diagnostic-run/ (gitignored) — safe to delete anytime; a write
 * failure (e.g. read-only FS) is swallowed since this is best-effort only
 * and must never fail a real run.
 */
const RAW_CAPTURE_KEEP = 5;
function captureRawOutput(providerId: string, stdout: string): void {
  try {
    const dir = path.join(APP_ROOT, 'data', 'diagnostic-run');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // Random suffix guards against two runs finishing in the same
    // millisecond and colliding on the filename (would otherwise silently
    // overwrite one capture instead of keeping both).
    const suffix = Math.random().toString(36).slice(2, 8);
    const prefix = `raw-${providerId}-`;
    fs.writeFileSync(path.join(dir, `${prefix}${stamp}-${suffix}.jsonl`), stdout, 'utf8');
    const files = fs
      .readdirSync(dir)
      .filter((f: string) => f.startsWith(prefix))
      .sort(); // ISO timestamps in the filename sort chronologically
    for (const f of files.slice(0, Math.max(0, files.length - RAW_CAPTURE_KEEP))) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {
    /* best-effort diagnostics only — never fail the run because of this */
  }
}

export type ProviderOptions = { model?: string };

export type RunRequest = {
  skill: Skill;
  artifactType: ArtifactType;
  inputText: string;
  inputFiles: Array<{ name: string; content: string }>;
  date: string; // ISO date for daily/wiki, week label for weekly
  sourceRef: string;
  options?: ProviderOptions;
  /** Called with each line of raw provider output as it streams in (CLI providers only). */
  onChunk?: (line: string) => void;
};

/** Model name + token/cost/credit usage reported by (or estimated for) a provider run. */
export type UsageInfo = {
  model?: string;
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
  /** GitHub Copilot "premium request" credits ($100 = 10,000 credits, i.e. $0.01/credit). */
  credits?: number;
};

export type RunResult =
  | { ok: true; output: string; commandLine?: string; usage?: UsageInfo }
  | { ok: false; error: string; commandLine?: string };

export type ProviderHealth = {
  healthy: boolean;
  detail: string;
  command?: string;
};

export interface AgentProvider {
  id: ProviderId;
  name: string;
  capabilities: string[];
  healthCheck(): Promise<ProviderHealth>;
  runSkill(req: RunRequest): Promise<RunResult>;
  summarizeRun(runId: string, store: Store): Promise<string>;
}

function summarize(runId: string, store: Store): string {
  const run = store.getRun(runId);
  if (!run) return `Run ${runId} not found.`;
  return (
    `Run ${run.id.slice(0, 8)} — ${run.artifact_type} via ${run.provider_id}, status ${run.status}. ` +
    `Skill "${run.skill_name}" (${run.skill_hash.slice(0, 12)}), ${run.input_files.length} input file(s)` +
    (run.output_artifact_path ? `, wrote ${run.output_artifact_path}` : '') +
    (run.error ? `. Error: ${run.error}` : '.')
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
export class MockProvider implements AgentProvider {
  id = 'mock' as const;
  name = 'Mock Provider (deterministic, offline)';
  capabilities = ['daily-log', 'weekly-report', 'wiki-source', 'offline', 'deterministic'];

  async healthCheck(): Promise<ProviderHealth> {
    return { healthy: true, detail: 'Always available. Deterministic output, no external AI.' };
  }

  async runSkill(req: RunRequest): Promise<RunResult> {
    try {
      req.onChunk?.(`[mock] loading skill "${req.skill.name}"...`);
      await delay(150);
      req.onChunk?.(`[mock] reading ${req.inputFiles.length || 1} input source(s)...`);
      await delay(150);
      req.onChunk?.(`[mock] drafting ${req.artifactType} markdown...`);
      await delay(200);
      let output: string;
      if (req.artifactType === 'daily-log') {
        output = genDailyLog({
          date: req.date,
          notes: req.inputText,
          skill: req.skill,
          providerId: this.id,
          sourceRef: req.sourceRef,
        });
      } else if (req.artifactType === 'weekly-report') {
        output = genWeeklyReport({
          weekLabel: req.date,
          logs: req.inputFiles,
          skill: req.skill,
          providerId: this.id,
        });
      } else if (req.artifactType === 'wiki-source') {
        output = genWikiSource({
          date: req.date,
          sources: req.inputFiles,
          skill: req.skill,
          providerId: this.id,
        });
      } else {
        output = genGeneric({
          outputType: req.artifactType,
          label: req.date,
          inputText: req.inputText,
          sources: req.inputFiles,
          skill: req.skill,
          providerId: this.id,
          sourceRef: req.sourceRef,
        });
      }
      req.onChunk?.('[mock] done.');
      return {
        ok: true,
        output,
        usage: {
          model: 'mock',
          tokensInput: Math.ceil(req.inputText.length / 4),
          tokensOutput: Math.ceil(output.length / 4),
        },
      };
    } catch (err) {
      return { ok: false, error: `MockProvider failed: ${(err as Error).message}` };
    }
  }

  async summarizeRun(runId: string, store: Store): Promise<string> {
    return summarize(runId, store);
  }
}

// ---------------------------------------------------------------------------
// Real CLI execution. Providers are invoked with spawn only — never a
// shell — with a hard timeout and output cap, streaming stdout/stderr lines
// to the caller as they arrive (see execInvocation's onChunk). The prompt is
// the skill markdown + a delimited input block + a "markdown only" instruction.
//
// Copilot/Claude CLIs emit their live progress as JSONL event streams, not
// plain text — passed through raw that's a wall of JSON in the live-run
// pane. Each provider overrides makeLiveLineHandler() to turn those events
// into short terminal-style status lines and the actual streamed answer
// text, so a run reads like a real CLI working rather than a JSON dump.

const CLI_TIMEOUT_MS = 120_000;
const CLI_MAX_BUFFER = 8 * 1024 * 1024; // manual accumulation cap (stdout+stderr each)
const MAX_ARTIFACT_BYTES = 1_000_000; // final artifact size cap
const MAX_INLINE_PROMPT = 30_000; // stay under the Windows 32 KiB command-line limit
const MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/; // keeps argv safe even via cmd.exe shims

export function composePrompt(req: RunRequest): string {
  return [
    req.skill.raw.trim(),
    '',
    `=== INPUT (${req.artifactType} • ${req.date}) ===`,
    req.inputText.trim(),
    '=== END INPUT ===',
    '',
    `Produce the ${req.artifactType} markdown artifact for the input above. Use "${req.date}" as the date/week label.`,
    'Output ONLY the final markdown document — no preamble, no commentary, no code fences.',
  ].join('\n');
}

// GitHub Copilot billing moved from a flat "1 premium request per prompt"
// legacy counter to per-token "AI credits" (1 credit = $0.01 USD), priced
// per model (see docs.github.com/copilot/reference/copilot-billing/models-and-pricing).
// Copilot CLI's headless `--output-format=json` only ever reports the old
// `usage.premiumRequests` request-COUNT field (GitHub's own SDK marks this
// `@internal`/legacy) — it does not report actual token-based cost. Treating
// that count as if it were the AI-credit cost silently mis-reports real
// spend (e.g. always shows "1 credit" for any single-turn run, regardless of
// how many tokens it actually used). Instead we estimate real cost from the
// model + token counts using GitHub's published per-1M-token rates below.
// Unrecognized/future model ids fall back to undefined (no fabricated
// number) rather than a wrong price.
const USD_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-5.3-codex': { input: 1.75, output: 14.0 },
  'gpt-5.4': { input: 2.5, output: 15.0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'gpt-5.5': { input: 5.0, output: 30.0 },
  'claude-haiku-4.5': { input: 1.0, output: 5.0 },
  'claude-sonnet-4': { input: 3.0, output: 15.0 },
  'claude-sonnet-4.5': { input: 3.0, output: 15.0 },
  'claude-sonnet-4.6': { input: 3.0, output: 15.0 },
  'claude-sonnet-5': { input: 2.0, output: 10.0 }, // promotional pricing through 2026-08-31
  'claude-opus-4.5': { input: 5.0, output: 25.0 },
  'claude-opus-4.6': { input: 5.0, output: 25.0 },
  'claude-opus-4.7': { input: 5.0, output: 25.0 },
  'claude-opus-4.8': { input: 5.0, output: 25.0 },
  'claude-fable-5': { input: 10.0, output: 50.0 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-3-flash': { input: 0.5, output: 3.0 },
  'gemini-3.1-pro': { input: 2.0, output: 12.0 },
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
  'raptor-mini': { input: 0.25, output: 2.0 },
  'mai-code-1-flash': { input: 0.75, output: 4.5 },
  'kimi-k2.7-code': { input: 0.95, output: 4.0 },
};

/** Normalizes a model id/display name (e.g. "Claude Opus 4.8 (fast mode) (preview)",
 * "claude-sonnet-5") into the lowercase-hyphenated form used as USD_PER_1M_TOKENS keys. */
function normalizeModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/\((?:fast mode|preview)\)/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Estimates real USD cost from a model id + token counts using GitHub's
 * published per-token pricing. Returns undefined for unrecognized models
 * rather than guessing — callers should fall back to other signals if any. */
function estimateCostUsd(model: string | undefined, tokensInput: number | undefined, tokensOutput: number | undefined): number | undefined {
  if (!model) return undefined;
  const rates = USD_PER_1M_TOKENS[normalizeModelId(model)];
  if (!rates) return undefined;
  const inCost = ((tokensInput ?? 0) / 1_000_000) * rates.input;
  const outCost = ((tokensOutput ?? 0) / 1_000_000) * rates.output;
  return inCost + outCost;
}

/** Rough token estimate (chars/4) for text we don't get an exact count for
 * from a provider — same heuristic MockProvider uses for its estimates. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Models multi-turn agentic cost from observed turn output sizes: turn K's
 * real input is (base prompt) + (everything from turns 1..K-1), so each
 * extra turn resends the base prompt again plus all prior turns' generated
 * content AND any tool results injected along the way.
 *
 * `generatedChars[k]` is content the MODEL produced during turn k — final
 * message text, reasoning, and tool-call arguments — which counts as real
 * OUTPUT tokens for that turn (and gets resent as input on every later
 * turn). `toolResultChars[k]` is tool execution RESULT content returned
 * during turn k (e.g. a file's contents read back) — the model didn't
 * generate this, so it is NOT counted as output tokens, but it DOES get
 * appended to conversation context and resent as input on later turns.
 * Conflating the two would over-count output tokens (priced ~5x higher
 * than input for claude-sonnet-5), so they're tracked separately.
 *
 * For a single turn with no tool results this reduces to exactly
 * `{ tokensInput: basePromptTokens, tokensOutput: that turn's generated tokens }`. */
function estimateMultiTurnTokens(
  basePromptTokens: number,
  generatedChars: number[],
  toolResultChars: number[] = [],
): { tokensInput: number; tokensOutput: number } {
  let cumulativeInput = 0;
  let priorContext = 0;
  let totalOutput = 0;
  for (let i = 0; i < generatedChars.length; i++) {
    const genTokens = Math.ceil(generatedChars[i] / 4);
    const toolTokens = Math.ceil((toolResultChars[i] ?? 0) / 4);
    cumulativeInput += basePromptTokens + priorContext;
    priorContext += genTokens + toolTokens;
    totalOutput += genTokens;
  }
  return { tokensInput: cumulativeInput, tokensOutput: totalOutput };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Remove a wrapping ```/```markdown fence if the model added one anyway. */
function unfence(s: string): string {
  const m = s.trim().match(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/);
  return m ? m[1] : s.trim();
}

function toNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Like toNonEmptyString but preserves whitespace — required for streamed
 * delta text, where leading/trailing spaces between chunks are significant
 * (trimming them would glue words together, e.g. "foo " + "bar" -> "foobar"). */
function toRawString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function toFiniteNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Buffers streamed delta text and emits complete lines as they're formed,
 * holding the trailing partial line until more text (or `flush`) arrives.
 * Used to turn token-by-token JSONL deltas into readable streamed lines
 * instead of emitting a ragged fragment per event.
 */
class TextAccumulator {
  private partial = '';
  private emit: (line: string) => void;
  constructor(emit: (line: string) => void) {
    this.emit = emit;
  }
  add(text: string): void {
    if (!text) return;
    const combined = this.partial + text;
    const parts = combined.split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const p of parts) this.emit(p);
  }
  flush(): void {
    if (this.partial) {
      this.emit(this.partial);
      this.partial = '';
    }
  }
}

type Invocation = {
  file: string;
  args: string[];
  stdinData?: string;
  /** exact command line minus the prompt body, recorded on the run */
  display: string;
};

function execInvocation(
  inv: Invocation,
  onChunk?: (line: string, isStdout: boolean) => void,
): Promise<{ failed: boolean; codeInfo: string; timedOut: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(inv.file, inv.args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let stdoutPartial = '';
    let stderrPartial = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let overflowed = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CLI_TIMEOUT_MS);

    const finish = (failed: boolean, codeInfo: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ failed, codeInfo, timedOut, stdout, stderr });
    };

    // Splits each chunk into complete lines (buffering a trailing partial
    // line across chunks) and forwards them to onChunk as they arrive, so
    // the live-run pane sees output progressively instead of all at once.
    const drain = (chunk: Buffer, isStdout: boolean) => {
      const text = chunk.toString('utf8');
      if (isStdout) {
        stdout += text;
        stdoutBytes += chunk.length;
      } else {
        stderr += text;
        stderrBytes += chunk.length;
      }
      if (stdoutBytes > CLI_MAX_BUFFER || stderrBytes > CLI_MAX_BUFFER) {
        if (!overflowed) {
          overflowed = true;
          child.kill();
        }
        return;
      }
      const combined = (isStdout ? stdoutPartial : stderrPartial) + text;
      const parts = combined.split(/\r?\n/);
      const trailing = parts.pop() ?? '';
      if (isStdout) stdoutPartial = trailing;
      else stderrPartial = trailing;
      for (const line of parts) if (line) onChunk?.(line, isStdout);
    };

    child.stdout?.on('data', (c: Buffer) => drain(c, true));
    child.stderr?.on('data', (c: Buffer) => drain(c, false));
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(true, String(err.code ?? err.message.split('\n')[0]));
    });
    child.on('close', (code) => {
      finish(code !== 0, overflowed ? 'OUTPUT_TOO_LARGE' : String(code ?? 0));
    });

    if (child.stdin) {
      child.stdin.on('error', () => {});
      if (inv.stdinData !== undefined) child.stdin.write(inv.stdinData);
      child.stdin.end();
    }
  });
}

abstract class CliProviderBase implements AgentProvider {
  abstract id: ProviderId;
  abstract name: string;
  abstract defaultCommand: string;
  capabilities = ['daily-log', 'weekly-report', 'wiki-source', 'cli-execution'];

  protected configuredPath: string;

  constructor(configuredPath: string) {
    this.configuredPath = configuredPath;
  }

  protected resolveCommand(): string {
    return this.configuredPath ? resolveConfigPath(this.configuredPath) : this.defaultCommand;
  }

  /**
   * Provider-specific argv. `inlinePrompt` is null when the prompt is being
   * delivered via stdin instead; return null from that case if the CLI cannot
   * accept a stdin prompt.
   */
  protected abstract buildArgs(inlinePrompt: string | null, model: string): string[] | null;

  /**
   * Extract the final artifact markdown (and any model/token/cost usage) from
   * raw CLI stdout. Default: stdout is the artifact text as-is, no usage.
   * Providers with structured (JSON/JSONL) output formats override this.
   */
  protected parseOutput(stdout: string, _req: RunRequest, _model: string): { output: string; usage?: UsageInfo } {
    return { output: stdout };
  }

  /**
   * Turns raw stdout/stderr lines from the running CLI into lines for the
   * live-run pane. Default: pass stdout through unchanged and prefix stderr,
   * i.e. today's plain-text behavior. Providers with structured (JSONL)
   * live-output formats override this to render friendly status/typing
   * lines instead of raw JSON — see ClaudeCliProvider/CopilotCliProvider.
   */
  protected makeLiveLineHandler(onChunk: (line: string) => void, _req: RunRequest): (rawLine: string, isStdout: boolean) => void {
    return (rawLine, isStdout) => onChunk(isStdout ? rawLine : `[stderr] ${rawLine}`);
  }

  async healthCheck(): Promise<ProviderHealth> {
    const cmd = this.resolveCommand();
    // A configured explicit path: verify the file exists.
    if (this.configuredPath) {
      if (fs.existsSync(cmd)) return { healthy: true, detail: `Configured command found: ${cmd}`, command: cmd };
      // Not a file — maybe a bare command name was configured; fall through to PATH lookup.
      if (/[\\/]/.test(this.configuredPath)) {
        return { healthy: false, detail: `Configured command not found: ${cmd}`, command: cmd };
      }
    }
    const name = this.configuredPath || this.defaultCommand;
    const found = await lookupOnPath(name);
    return found
      ? { healthy: true, detail: `Found on PATH: ${found}`, command: found }
      : { healthy: false, detail: `'${name}' not found on PATH and no path configured.`, command: name };
  }

  private buildInvocation(command: string, prompt: string, model: string): Invocation | { error: string } {
    if (model && !MODEL_RE.test(model)) {
      return { error: `Invalid model name "${model}" — letters, digits, . _ : - only.` };
    }
    const isCmdShim = /\.(cmd|bat)$/i.test(command);
    const baseName = path.basename(command);
    const useStdin = isCmdShim || prompt.length > MAX_INLINE_PROMPT;
    const args = this.buildArgs(useStdin ? null : prompt, model);
    if (args === null) {
      return {
        error:
          `${this.name}: the prompt cannot be passed ${isCmdShim ? `through the ${baseName} shim` : 'inline (too large)'} ` +
          `and this CLI does not accept a stdin prompt. Configure the full path to the real executable (.exe) in Settings.`,
      };
    }
    const display =
      `${baseName} ` +
      args.map((a) => (a === prompt ? '<prompt>' : a)).join(' ') +
      (useStdin ? ' (prompt via stdin)' : '');
    if (isCmdShim) {
      // .cmd/.bat cannot be spawned directly (and never with a multiline argv),
      // so run the shim under cmd.exe with fixed, validated flags only; the
      // prompt travels via stdin and never touches the cmd.exe command line.
      return { file: 'cmd.exe', args: ['/d', '/s', '/c', command, ...args], stdinData: prompt, display };
    }
    return { file: command, args, stdinData: useStdin ? prompt : undefined, display };
  }

  async runSkill(req: RunRequest): Promise<RunResult> {
    const health = await this.healthCheck();
    if (!health.healthy) {
      return {
        ok: false,
        error: `${this.name} unavailable: ${health.detail} Use the mock provider, or configure the CLI path in Settings.`,
      };
    }
    const prompt = composePrompt(req);
    const inv = this.buildInvocation(health.command ?? this.resolveCommand(), prompt, req.options?.model ?? '');
    if ('error' in inv) return { ok: false, error: inv.error };

    const res = await execInvocation(inv, req.onChunk ? this.makeLiveLineHandler(req.onChunk, req) : undefined);
    captureRawOutput(this.id, res.stdout);
    const stderrTail = stripAnsi(res.stderr).trim().slice(-800);
    if (res.timedOut) {
      return { ok: false, error: `${this.name} timed out after ${CLI_TIMEOUT_MS / 1000}s.`, commandLine: inv.display };
    }
    if (res.failed) {
      return {
        ok: false,
        error: `${this.name} failed (${res.codeInfo}).${stderrTail ? ` stderr: ${stderrTail}` : ''}`,
        commandLine: inv.display,
      };
    }
    const parsed = this.parseOutput(res.stdout, req, req.options?.model ?? '');
    let output = unfence(stripAnsi(parsed.output));
    if (!output) {
      return {
        ok: false,
        error: `${this.name} produced no output.${stderrTail ? ` stderr: ${stderrTail}` : ''}`,
        commandLine: inv.display,
      };
    }
    if (Buffer.byteLength(output, 'utf8') > MAX_ARTIFACT_BYTES) {
      output = output.slice(0, MAX_ARTIFACT_BYTES) + '\n\n> [output truncated at 1 MB by Agentic Workbench]\n';
    }
    return { ok: true, output: output + '\n', commandLine: inv.display, usage: parsed.usage };
  }

  async summarizeRun(runId: string, store: Store): Promise<string> {
    return summarize(runId, store);
  }
}

async function lookupOnPath(name: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    try {
      execFile(finder, [name], { timeout: 4000, windowsHide: true }, (err, stdout) => {
        if (err || !stdout.trim()) return resolve(null);
        const lines = stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        // Prefer a real executable over npm's extensionless/cmd shims.
        resolve(lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.(cmd|bat)$/i.test(l)) ?? lines[0]);
      });
    } catch {
      resolve(null);
    }
  });
}

export class ClaudeCliProvider extends CliProviderBase {
  id = 'claude-cli' as const;
  name = 'Claude CLI';
  defaultCommand = 'claude';

  // claude -p "<prompt>" --output-format stream-json --verbose
  // --include-partial-messages; with no positional prompt, -p reads the
  // prompt from stdin. stream-json emits NDJSON events as the run
  // progresses (so the live-run pane can show real-time output), ending
  // with a `result`-typed event carrying the artifact text plus real
  // usage/cost metadata (see parseOutput below). --verbose and
  // --include-partial-messages are required by the CLI for this mode.
  protected buildArgs(inlinePrompt: string | null, model: string): string[] {
    return [
      '-p',
      ...(inlinePrompt !== null ? [inlinePrompt] : []),
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(model ? ['--model', model] : []),
    ];
  }

  // claude -p --output-format stream-json emits NDJSON — one event object
  // per line — ending with a `type: 'result'` event that carries the final
  // artifact text in `result` plus usage/cost metadata, in the same shape
  // the older buffered `json` mode returned as its single object. Scan for
  // the last such event; older CLI versions (or unexpected output) may not
  // emit any JSON at all — fall back to treating stdout as the raw artifact
  // text so generation never breaks.
  protected parseOutput(stdout: string, _req: RunRequest, model: string): { output: string; usage?: UsageInfo } {
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    let resultObj: Record<string, unknown> | undefined;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj && obj.type === 'result') resultObj = obj;
      } catch {
        /* not a JSON line — ignore (banner text, log noise, etc.) */
      }
    }
    if (!resultObj) return { output: stdout };
    const usageObj = (resultObj.usage ?? {}) as Record<string, unknown>;
    return {
      output: toNonEmptyString(resultObj.result) ?? '',
      usage: {
        model: toNonEmptyString(resultObj.model) ?? (model || undefined),
        tokensInput: toFiniteNumber(usageObj.input_tokens),
        tokensOutput: toFiniteNumber(usageObj.output_tokens),
        costUsd: toFiniteNumber(resultObj.total_cost_usd) ?? toFiniteNumber(resultObj.cost_usd),
      },
    };
  }

  // Renders `--output-format stream-json --include-partial-messages` NDJSON
  // as terminal-style lines instead of raw JSON: a short status line for
  // session init, the answer text streamed in as `stream_event` content
  // deltas arrive (so it reads like the model typing), and a one-line
  // summary from the final `result` event. Any event type not recognized
  // here (turn bookkeeping, tool-use deltas, etc.) is silently dropped
  // rather than dumped as JSON; non-JSON lines (banner/log text) pass
  // through unchanged.
  protected makeLiveLineHandler(onChunk: (line: string) => void, _req: RunRequest): (rawLine: string, isStdout: boolean) => void {
    const acc = new TextAccumulator(onChunk);
    return (rawLine, isStdout) => {
      if (!isStdout) return onChunk(`[stderr] ${rawLine}`);
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(rawLine) as Record<string, unknown>;
      } catch {
        return onChunk(rawLine); // not JSON — pass through as-is
      }
      const type = toNonEmptyString(obj.type);
      switch (type) {
        case 'system': {
          if (toNonEmptyString(obj.subtype) === 'init') {
            const model = toNonEmptyString(obj.model);
            onChunk(model ? `» session started (model: ${model})` : '» session started');
          }
          return;
        }
        case 'stream_event': {
          const ev = (obj.event ?? {}) as Record<string, unknown>;
          const evType = toNonEmptyString(ev.type);
          if (evType === 'content_block_delta') {
            const delta = (ev.delta ?? {}) as Record<string, unknown>;
            acc.add(toRawString(delta.text));
          } else if (evType === 'message_stop') {
            acc.flush();
          }
          return;
        }
        case 'result': {
          acc.flush();
          const cost = toFiniteNumber(obj.total_cost_usd) ?? toFiniteNumber(obj.cost_usd);
          onChunk(cost !== undefined ? `» done ($${cost.toFixed(4)})` : '» done.');
          return;
        }
        default:
          return; // suppress turn/tool bookkeeping noise
      }
    };
  }
}

export class CopilotCliProvider extends CliProviderBase {
  id = 'copilot-cli' as const;
  name = 'GitHub Copilot CLI';
  defaultCommand = 'copilot';

  // copilot -p/--prompt <text> is its non-interactive mode; it has no stdin
  // prompt equivalent, so oversized/shim cases return null (clear error).
  // No --allow-* flags are passed: Copilot cannot edit files or run commands.
  // --output-format=json emits JSONL (one JSON object per line) carrying the
  // final response plus usage/cost metadata (see parseOutput below).
  protected buildArgs(inlinePrompt: string | null, model: string): string[] | null {
    if (inlinePrompt === null) return null;
    return ['-p', inlinePrompt, '--output-format=json', ...(model ? ['--model', model] : [])];
  }

  // Copilot CLI's `--output-format=json` emits JSONL — one event object per
  // line, shaped like `{ type, data, ... }`.
  //
  // CONFIRMED from real, live runs (2026-07-10):
  //   - `assistant.message` : data.content (turn's text), data.model. NO
  //                           data.outputTokens / data.inputTokens field was
  //                           ever present — the CLI does not report
  //                           per-turn token counts (contrary to earlier
  //                           assumption). Extraction of those fields is
  //                           kept only in case a future CLI version adds
  //                           them.
  //   - `assistant.turn_start` : fires once per model turn. A simple
  //                              daily-log run showed exactly one; a
  //                              log-work-note run (which reads/edits an
  //                              existing file) showed TWO — i.e. the CLI
  //                              made a tool call (e.g. reading the current
  //                              weekly log) before writing the final
  //                              answer. Agentic/tool-using skills are
  //                              multi-turn, not single-shot.
  //   - `session.tools_updated` : data.model (fallback if assistant.message is missing)
  //   - `result` (last line)   : top-level `usage` object contains ONLY
  //                              `premiumRequests` (legacy GitHub Copilot
  //                              "premium request" COUNT, 1 per prompt sent —
  //                              NOT a token-based cost figure), plus timing
  //                              and codeChanges fields. No cost, no input
  //                              tokens, no output tokens are ever reported.
  //
  // Because NEITHER input nor output tokens are ever reported, both must be
  // estimated locally — and because runs are often multi-turn, a naive
  // "one prompt in, one response out" estimate massively under-counts: in a
  // real agentic loop, turn 2+ RESENDS the base prompt plus everything from
  // prior turns, so cost grows roughly with turnCount, not just once. See
  // the turn-aware modeling below (turnOutputChars / perTurnOutputTokens)
  // for how input/output are approximated across all observed turns, then
  // $ cost is derived from the model + those token counts via
  // USD_PER_1M_TOKENS. premiumRequests is kept only as a last-resort
  // fallback if the model is unrecognized (no pricing data available).
  //
  // KNOWN RESIDUAL UNDER-COUNT: even the turn-aware model above is a floor,
  // not an exact figure, because two things the CLI sends to the real model
  // are completely invisible to us and cannot be estimated at all:
  //   1. Hidden system context: the full list of the user's personal
  //      Copilot skills (`session.skills_loaded`, names + full descriptions)
  //      and MCP server tool schemas — sent on every turn, billed by GitHub,
  //      never appears in composePrompt(req).
  //   2. Tool call arguments AND tool call results — e.g. the actual
  //      contents of a file the CLI reads back mid-run (this is likely the
  //      single largest unseen cost driver for file-editing skills like
  //      log-work-note, since a growing weekly log file gets fully resent
  //      as context on every subsequent turn). We only see turn boundaries
  //      and each turn's final visible text, never the tool payloads.
  // Estimates here will therefore typically still run BELOW GitHub's real
  // billed AI credits, especially for multi-turn/file-touching skills;
  // treat them as a floor, not an exact figure. See GitHub's Copilot usage
  // dashboard for ground truth.
  //
  // Older/unknown CLI versions may use different shapes — this function
  // scans defensively and falls back to raw stdout text if nothing matches.
  protected parseOutput(stdout: string, req: RunRequest, model: string): { output: string; usage?: UsageInfo } {
    const lines = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const objects: Record<string, unknown>[] = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object') objects.push(obj as Record<string, unknown>);
      } catch {
        /* not a JSON line — ignore (banner text, log noise, etc.) */
      }
    }
    if (!objects.length) return { output: stdout };

    let resultText = '';
    let usedModel: string | undefined;
    let tokensInput: number | undefined;
    let tokensOutput: number | undefined;
    let costUsd: number | undefined;
    let credits: number | undefined;
    let legacyPremiumRequests: number | undefined;
    // Multi-turn/tool-use tracking (CONFIRMED 2026-07-10 via real runs, most
    // recently 57cba267's raw capture): `assistant.turn_start` fires once
    // per model turn, and a tool-using run's turns also emit
    // `assistant.reasoning` (full reasoning text), `tool.execution_start`
    // (data.arguments — the tool call's full input object) and
    // `tool.execution_complete` (data.result.content/detailedContent — the
    // tool's actual output, e.g. a file's contents read back). All of this
    // was previously invisible (silently dropped by the fixed event
    // allow-list), and is the dominant source of under-estimation for
    // agentic, file-touching skills. `turnGeneratedChars` holds one entry
    // per observed turn — chars of that turn's MODEL-GENERATED content
    // (reasoning + tool-call args + final message), billed as output.
    // `turnToolResultChars` holds tool execution RESULT content per turn —
    // not model output, but still resent as input on later turns. See
    // estimateMultiTurnTokens for how the two combine.
    let turnCount = 0;
    const turnGeneratedChars: number[] = [];
    const turnToolResultChars: number[] = [];

    for (const obj of objects) {
      const type = toNonEmptyString(obj.type);
      const data = (obj.data ?? {}) as Record<string, unknown>;

      if (type === 'assistant.turn_start') {
        turnCount++;
        turnGeneratedChars.push(0);
        turnToolResultChars.push(0);
      } else if (type === 'assistant.reasoning') {
        const content = toNonEmptyString(data.content);
        if (content) {
          if (turnGeneratedChars.length) turnGeneratedChars[turnGeneratedChars.length - 1] += content.length;
          else turnGeneratedChars.push(content.length);
        }
      } else if (type === 'tool.execution_start') {
        const args = data.arguments;
        if (args && typeof args === 'object') {
          const len = JSON.stringify(args).length;
          if (turnGeneratedChars.length) turnGeneratedChars[turnGeneratedChars.length - 1] += len;
          else turnGeneratedChars.push(len);
        }
      } else if (type === 'tool.execution_complete') {
        const result = (data.result ?? {}) as Record<string, unknown>;
        const content = toNonEmptyString(result.detailedContent) ?? toNonEmptyString(result.content);
        if (content) {
          if (turnToolResultChars.length) turnToolResultChars[turnToolResultChars.length - 1] += content.length;
          else turnToolResultChars.push(content.length);
        }
      } else if (type === 'assistant.message') {
        const content = toNonEmptyString(data.content);
        if (content) {
          resultText = content;
          if (turnGeneratedChars.length) turnGeneratedChars[turnGeneratedChars.length - 1] += content.length;
          else turnGeneratedChars.push(content.length); // older CLI build with no turn_start events
        }
        usedModel = toNonEmptyString(data.model) ?? usedModel;
        // Accumulate (not overwrite) in case a future CLI version starts
        // reporting per-turn token counts across multiple assistant.message
        // events — a multi-turn/tool-using run sends several turns, and
        // overwriting would silently keep only the last turn's tokens.
        const turnOutputTokens = toFiniteNumber(data.outputTokens);
        if (turnOutputTokens !== undefined) tokensOutput = (tokensOutput ?? 0) + turnOutputTokens;
        const turnInputTokens = toFiniteNumber(data.inputTokens);
        if (turnInputTokens !== undefined) tokensInput = (tokensInput ?? 0) + turnInputTokens;
      } else if (type === 'session.tools_updated') {
        usedModel = toNonEmptyString(data.model) ?? usedModel;
      } else if (type === 'result') {
        // `usage` lives on the top-level result event, not under `data`.
        const usageObj = (obj.usage ?? data.usage ?? {}) as Record<string, unknown>;
        // Legacy request-count field — NOT a credit/cost figure. Kept only as
        // `legacyPremiumRequests` for the last-resort fallback below.
        legacyPremiumRequests = toFiniteNumber(usageObj.premiumRequests) ?? legacyPremiumRequests;
        costUsd = toFiniteNumber(usageObj.cost) ?? toFiniteNumber(usageObj.total_cost_usd) ?? costUsd;
      }

      // Fallback field names in case future/older CLI builds use different
      // shapes (e.g. flat objects instead of the `{ type, data }` envelope,
      // or OTel-style attribute names).
      if (!resultText) {
        resultText = toNonEmptyString(obj.result) ?? toNonEmptyString(obj.content) ?? toNonEmptyString(obj.text) ?? resultText;
      }
      usedModel = usedModel ?? toNonEmptyString(obj.model) ?? toNonEmptyString(obj['gen_ai.response.model']);
      const flatUsage = (obj.usage ?? {}) as Record<string, unknown>;
      tokensInput = tokensInput ?? toFiniteNumber(flatUsage.input_tokens) ?? toFiniteNumber(obj['gen_ai.usage.input_tokens']);
      tokensOutput = tokensOutput ?? toFiniteNumber(flatUsage.output_tokens) ?? toFiniteNumber(obj['gen_ai.usage.output_tokens']);
      costUsd = costUsd ?? toFiniteNumber(obj.cost) ?? toFiniteNumber(obj['github.copilot.cost']);
      credits =
        credits ??
        toFiniteNumber(obj.credits) ??
        toFiniteNumber(obj['github.copilot.credits']) ??
        toFiniteNumber(obj['github.copilot.aiu']);
    }

    const finalModel = usedModel ?? (model || undefined);
    // FIX (2026-07-10, revised): both input and output token estimates now
    // model MULTIPLE turns, not just one prompt/response pair. Evidence: a
    // real log-work-note run showed `assistant.turn_start` fire twice
    // (the CLI read the existing log file via a tool call before writing
    // the final entry). See estimateMultiTurnTokens for the model. For a
    // single-turn run this reduces exactly to the old estimate
    // (basePromptTokens in, that one turn's text out) — no regression there.
    const basePromptTokens = estimateTokens(composePrompt(req));
    const effectiveGeneratedChars = turnGeneratedChars.length ? turnGeneratedChars : [(resultText || stdout).length];
    const effectiveToolResultChars =
      turnToolResultChars.length === effectiveGeneratedChars.length ? turnToolResultChars : effectiveGeneratedChars.map(() => 0);
    const multiTurn = estimateMultiTurnTokens(basePromptTokens, effectiveGeneratedChars, effectiveToolResultChars);
    if (tokensInput === undefined) tokensInput = multiTurn.tokensInput;
    if (tokensOutput === undefined) tokensOutput = multiTurn.tokensOutput;

    // Prefer a real cost estimate derived from model + token counts. Only if
    // the model is unrecognized (no pricing data) do we fall back to the
    // legacy premiumRequests request-count as a rough, clearly-approximate
    // stand-in for credits.
    if (costUsd === undefined) costUsd = estimateCostUsd(finalModel, tokensInput, tokensOutput);
    if (credits === undefined && costUsd !== undefined) credits = costUsd / USD_PER_CREDIT;
    if (credits === undefined && legacyPremiumRequests !== undefined) credits = legacyPremiumRequests;
    if (costUsd === undefined && credits !== undefined) costUsd = credits * USD_PER_CREDIT;

    return {
      output: resultText || stdout,
      usage: { model: finalModel, tokensInput, tokensOutput, costUsd, credits },
    };
  }

  // Renders `--output-format=json` NDJSON as terminal-style lines instead of
  // raw JSON (event shapes confirmed from a real run — see parseOutput
  // above): a short status line as MCP servers/skills load and the model is
  // selected, the answer text streamed in as `assistant.message_delta`
  // events arrive (so it reads like the model typing), and a one-line
  // summary from the final `result` event's credit usage. Turn/session
  // bookkeeping events (turn_start/end, idle, message envelopes, etc.) are
  // silently dropped rather than dumped as JSON; non-JSON lines (banner/log
  // text) pass through unchanged.
  protected makeLiveLineHandler(onChunk: (line: string) => void, req: RunRequest): (rawLine: string, isStdout: boolean) => void {
    const acc = new TextAccumulator(onChunk);
    let liveModel: string | undefined;
    const liveGeneratedChars: number[] = [];
    const liveToolResultChars: number[] = [];
    return (rawLine, isStdout) => {
      if (!isStdout) return onChunk(`[stderr] ${rawLine}`);
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(rawLine) as Record<string, unknown>;
      } catch {
        return onChunk(rawLine); // not JSON — pass through as-is
      }
      const type = toNonEmptyString(obj.type);
      const data = (obj.data ?? {}) as Record<string, unknown>;
      switch (type) {
        case 'session.mcp_servers_loaded': {
          const servers = Array.isArray(data.servers) ? (data.servers as Record<string, unknown>[]) : [];
          const names = servers.map((s) => toNonEmptyString(s.name)).filter((n): n is string => !!n);
          if (names.length) onChunk(`» mcp: ${names.join(', ')} ready`);
          return;
        }
        case 'session.skills_loaded': {
          const skills = Array.isArray(data.skills) ? (data.skills as unknown[]) : [];
          onChunk(`» loaded ${skills.length} skill(s)`);
          return;
        }
        case 'session.tools_updated': {
          const m = toNonEmptyString(data.model);
          if (m) {
            liveModel = m;
            onChunk(`» model: ${m}`);
          }
          return;
        }
        case 'assistant.turn_start':
          liveGeneratedChars.push(0);
          liveToolResultChars.push(0);
          onChunk('» generating...');
          return;
        case 'assistant.message_delta':
          acc.add(toRawString(data.deltaContent));
          return;
        case 'assistant.reasoning': {
          const content = toNonEmptyString(data.content);
          if (content) {
            if (liveGeneratedChars.length) liveGeneratedChars[liveGeneratedChars.length - 1] += content.length;
            else liveGeneratedChars.push(content.length);
          }
          return;
        }
        case 'tool.execution_start': {
          const toolName = toNonEmptyString(data.toolName);
          const args = data.arguments;
          if (args && typeof args === 'object') {
            const len = JSON.stringify(args).length;
            if (liveGeneratedChars.length) liveGeneratedChars[liveGeneratedChars.length - 1] += len;
            else liveGeneratedChars.push(len);
          }
          if (toolName) onChunk(`» tool: ${toolName}`);
          return;
        }
        case 'tool.execution_complete': {
          const result = (data.result ?? {}) as Record<string, unknown>;
          const content = toNonEmptyString(result.detailedContent) ?? toNonEmptyString(result.content);
          if (content) {
            if (liveToolResultChars.length) liveToolResultChars[liveToolResultChars.length - 1] += content.length;
            else liveToolResultChars.push(content.length);
          }
          return;
        }
        case 'assistant.message': {
          liveModel = toNonEmptyString(data.model) ?? liveModel;
          const content = toNonEmptyString(data.content);
          if (content) {
            if (liveGeneratedChars.length) liveGeneratedChars[liveGeneratedChars.length - 1] += content.length;
            else liveGeneratedChars.push(content.length);
          }
          return;
        }
        case 'assistant.turn_end':
          acc.flush();
          return;
        case 'result': {
          const usageObj = (obj.usage ?? data.usage ?? {}) as Record<string, unknown>;
          const basePromptTokens = estimateTokens(composePrompt(req));
          const multiTurn = estimateMultiTurnTokens(
            basePromptTokens,
            liveGeneratedChars.length ? liveGeneratedChars : [0],
            liveToolResultChars,
          );
          const costUsd =
            toFiniteNumber(usageObj.cost) ??
            toFiniteNumber(usageObj.total_cost_usd) ??
            estimateCostUsd(liveModel ?? req.options?.model, multiTurn.tokensInput, multiTurn.tokensOutput);
          const credits = costUsd !== undefined ? costUsd / USD_PER_CREDIT : toFiniteNumber(usageObj.premiumRequests);
          onChunk(credits !== undefined ? `» done (~${credits.toFixed(2)} credit${credits === 1 ? '' : 's'} used)` : '» done.');
          return;
        }
        default:
          return; // suppress mcp-connect noise, message envelopes, idle, etc.
      }
    };
  }
}

export function getProviders(cfg: Config): Record<ProviderId, AgentProvider> {
  return {
    mock: new MockProvider(),
    'claude-cli': new ClaudeCliProvider(cfg.claudeCliPath),
    'copilot-cli': new CopilotCliProvider(cfg.copilotCliPath),
  };
}

export function getProvider(cfg: Config, id: string): AgentProvider {
  const providers = getProviders(cfg);
  return providers[(id as ProviderId) in providers ? (id as ProviderId) : 'mock'];
}
