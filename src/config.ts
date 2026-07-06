import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const APP_ROOT = path.resolve(import.meta.dirname, '..');
export const EXAMPLES_SKILLS_DIR = path.join(APP_ROOT, 'examples', 'skills');
export const LOCAL_CONFIG_FILE = path.join(APP_ROOT, 'local-config.json');
export const ENV_LOCAL_FILE = path.join(APP_ROOT, '.env.local');

export const ProviderIdSchema = z.enum(['mock', 'claude-cli', 'copilot-cli']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

export const ConfigSchema = z.object({
  dataDir: z.string().default('./data'),
  skillsDir: z.string().default(''),
  obsidianVaultDir: z.string().default(''),
  dailyLogDir: z.string().default(''),
  weeklyReportDir: z.string().default(''),
  wikiSourceDir: z.string().default(''),
  defaultProvider: ProviderIdSchema.default('mock'),
  claudeCliPath: z.string().default(''),
  copilotCliPath: z.string().default(''),
  port: z.coerce.number().int().min(1).max(65535).default(3220),
  host: z.string().default('127.0.0.1'),
});
export type Config = z.infer<typeof ConfigSchema>;

// env var -> config key mapping (matches .env.example)
const ENV_MAP: Record<string, keyof Config> = {
  WORKBENCH_DATA_DIR: 'dataDir',
  WORKBENCH_SKILLS_DIR: 'skillsDir',
  WORKBENCH_OBSIDIAN_VAULT_DIR: 'obsidianVaultDir',
  WORKBENCH_DAILY_LOG_DIR: 'dailyLogDir',
  WORKBENCH_WEEKLY_REPORT_DIR: 'weeklyReportDir',
  WORKBENCH_WIKI_SOURCE_DIR: 'wikiSourceDir',
  WORKBENCH_DEFAULT_PROVIDER: 'defaultProvider',
  CLAUDE_CLI_PATH: 'claudeCliPath',
  COPILOT_CLI_PATH: 'copilotCliPath',
  WORKBENCH_PORT: 'port',
  WORKBENCH_HOST: 'host',
};

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  try {
    for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch {
    // unreadable env file: ignore, never crash on config
  }
  return out;
}

function readLocalConfigFile(): Record<string, unknown> {
  if (!fs.existsSync(LOCAL_CONFIG_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Resolve a configured path against the app root; '' stays ''. */
export function resolveConfigPath(p: string): string {
  if (!p) return '';
  return path.resolve(APP_ROOT, p);
}

export type LoadedConfig = Config & {
  /** which layer supplied each key: default | env | local-config */
  sources: Record<string, 'default' | 'env' | 'local-config'>;
};

/**
 * Load config fresh from disk. Precedence: local-config.json > .env.local /
 * process.env > schema defaults. Always returns a usable config; bad values
 * fall back to defaults rather than crashing.
 */
export function loadConfig(): LoadedConfig {
  const sources: LoadedConfig['sources'] = {};
  const merged: Record<string, unknown> = {};

  const envFile = parseEnvFile(ENV_LOCAL_FILE);
  for (const [envKey, cfgKey] of Object.entries(ENV_MAP)) {
    const v = process.env[envKey] ?? envFile[envKey];
    if (v !== undefined && v !== '') {
      merged[cfgKey] = v;
      sources[cfgKey] = 'env';
    }
  }

  const local = readLocalConfigFile();
  for (const [k, v] of Object.entries(local)) {
    if (v !== undefined && v !== null && v !== '' && k in ConfigSchema.shape) {
      merged[k] = v;
      sources[k] = 'local-config';
    }
  }

  let cfg: Config;
  const parsed = ConfigSchema.safeParse(merged);
  if (parsed.success) {
    cfg = parsed.data;
  } else {
    // Drop invalid keys and retry so one bad value never takes the app down.
    const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    for (const k of bad) delete merged[k];
    cfg = ConfigSchema.parse(merged);
  }

  for (const k of Object.keys(ConfigSchema.shape)) {
    if (!(k in sources)) sources[k] = 'default';
  }
  return { ...cfg, sources };
}

/** Persist settings from the UI into local-config.json (gitignored). */
export function saveLocalConfig(patch: Partial<Config>): LoadedConfig {
  const current = readLocalConfigFile();
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in ConfigSchema.shape)) continue;
    if (v === undefined || v === null) continue;
    next[k] = v;
  }
  fs.writeFileSync(LOCAL_CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return loadConfig();
}

/**
 * Effective skills directory: configured value if set, otherwise the first of
 * ./.copilot/skills, ~/.copilot/skills, ./skills that exists. '' if none.
 */
export function effectiveSkillsDir(cfg: Config): { dir: string; source: string } {
  if (cfg.skillsDir) return { dir: resolveConfigPath(cfg.skillsDir), source: 'configured' };
  const candidates = [
    { dir: path.join(APP_ROOT, '.copilot', 'skills'), source: 'default (./.copilot/skills)' },
    { dir: path.join(os.homedir(), '.copilot', 'skills'), source: 'default (~/.copilot/skills)' },
    { dir: path.join(APP_ROOT, 'skills'), source: 'default (./skills)' },
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c.dir) && fs.statSync(c.dir).isDirectory()) return c;
    } catch {
      /* ignore */
    }
  }
  return { dir: '', source: 'none (examples only)' };
}

export function dataDir(cfg: Config): string {
  return resolveConfigPath(cfg.dataDir) || path.join(APP_ROOT, 'data');
}
