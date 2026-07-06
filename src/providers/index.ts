import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveConfigPath, type Config, type ProviderId } from '../config.ts';
import type { Skill } from '../skills.ts';
import type { Store } from '../store.ts';
import { genDailyLog, genWeeklyReport, genWikiSource } from '../generate.ts';

export type ArtifactType = 'daily-log' | 'weekly-report' | 'wiki-source';

export type ProviderOptions = { model?: string };

export type RunRequest = {
  skill: Skill;
  artifactType: ArtifactType;
  inputText: string;
  inputFiles: Array<{ name: string; content: string }>;
  date: string; // ISO date for daily/wiki, week label for weekly
  sourceRef: string;
  options?: ProviderOptions;
};

export type RunResult =
  | { ok: true; output: string; commandLine?: string }
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
      } else {
        output = genWikiSource({
          date: req.date,
          sources: req.inputFiles,
          skill: req.skill,
          providerId: this.id,
        });
      }
      return { ok: true, output };
    } catch (err) {
      return { ok: false, error: `MockProvider failed: ${(err as Error).message}` };
    }
  }

  async summarizeRun(runId: string, store: Store): Promise<string> {
    return summarize(runId, store);
  }
}

// ---------------------------------------------------------------------------
// Real CLI execution. Providers are invoked with execFile only — never a
// shell — with a hard timeout and output cap. The prompt is the skill
// markdown + a delimited input block + a "markdown only" instruction.

const CLI_TIMEOUT_MS = 120_000;
const CLI_MAX_BUFFER = 8 * 1024 * 1024; // execFile hard cap (stdout+stderr each)
const MAX_ARTIFACT_BYTES = 1_000_000; // final artifact size cap
const MAX_INLINE_PROMPT = 30_000; // stay under the Windows 32 KiB command-line limit
const MODEL_RE = /^[A-Za-z0-9._:-]{1,64}$/; // keeps argv safe even via cmd.exe shims

function composePrompt(req: RunRequest): string {
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

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Remove a wrapping ```/```markdown fence if the model added one anyway. */
function unfence(s: string): string {
  const m = s.trim().match(/^```(?:markdown|md)?\r?\n([\s\S]*?)\r?\n```$/);
  return m ? m[1] : s.trim();
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
): Promise<{ failed: boolean; codeInfo: string; timedOut: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      inv.file,
      inv.args,
      { timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_BUFFER, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({
          failed: Boolean(e),
          // exit code for normal failures, errno string (e.g. ENOENT) for spawn failures
          codeInfo: e ? String(e.code ?? e.message.split('\n')[0]) : '0',
          timedOut: Boolean(e?.killed),
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
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

    const res = await execInvocation(inv);
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
    let output = unfence(stripAnsi(res.stdout));
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
    return { ok: true, output: output + '\n', commandLine: inv.display };
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

  // claude -p "<prompt>" --output-format text; with no positional prompt,
  // -p reads the prompt from stdin.
  protected buildArgs(inlinePrompt: string | null, model: string): string[] {
    return ['-p', ...(inlinePrompt !== null ? [inlinePrompt] : []), '--output-format', 'text', ...(model ? ['--model', model] : [])];
  }
}

export class CopilotCliProvider extends CliProviderBase {
  id = 'copilot-cli' as const;
  name = 'GitHub Copilot CLI';
  defaultCommand = 'copilot';

  // copilot -p/--prompt <text> is its non-interactive mode; it has no stdin
  // prompt equivalent, so oversized/shim cases return null (clear error).
  // No --allow-* flags are passed: Copilot cannot edit files or run commands.
  protected buildArgs(inlinePrompt: string | null, model: string): string[] | null {
    if (inlinePrompt === null) return null;
    return ['-p', inlinePrompt, ...(model ? ['--model', model] : [])];
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
