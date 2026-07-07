import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, EXAMPLES_SKILLS_DIR, dataDir, effectiveSkillsDir, resolveConfigPath, type Config } from './config.ts';

export type PathStatus = 'not-configured' | 'missing' | 'unreadable' | 'read-only' | 'writable';

export type PathCheck = {
  key: string;
  label: string;
  configured: string; // raw configured value ('' if none)
  resolved: string; // absolute path ('' if none)
  status: PathStatus;
  isDir: boolean;
  note: string; // human-readable detail, e.g. fallback in use
  fallback: string; // absolute fallback path used when not usable ('' if n/a)
};

/** Inspect a single directory path without ever throwing. */
export function checkDir(resolved: string): { status: PathStatus; isDir: boolean } {
  if (!resolved) return { status: 'not-configured', isDir: false };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { status: 'missing', isDir: false };
  }
  const isDir = stat.isDirectory();
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    return { status: 'unreadable', isDir };
  }
  try {
    fs.accessSync(resolved, fs.constants.W_OK);
    return { status: 'writable', isDir };
  } catch {
    return { status: 'read-only', isDir };
  }
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/** Local fallback folders under the data dir (created on demand). */
export function fallbackDirs(cfg: Config): Record<string, string> {
  const d = dataDir(cfg);
  return {
    dailyLogDir: path.join(d, 'daily-logs'),
    weeklyReportDir: path.join(d, 'weekly-reports'),
    wikiSourceDir: path.join(d, 'wiki-source'),
    inboxDir: path.join(d, 'inbox'),
  };
}

const PATH_LABELS: Array<{ key: keyof Config & string; label: string; output: boolean }> = [
  { key: 'skillsDir', label: 'Skills directory', output: false },
  { key: 'obsidianVaultDir', label: 'Obsidian vault root', output: false },
  { key: 'dailyLogDir', label: 'Daily log output folder', output: true },
  { key: 'weeklyReportDir', label: 'Weekly report output folder', output: true },
  { key: 'wikiSourceDir', label: 'Wiki source output folder', output: true },
  { key: 'dataDir', label: 'Local app data folder', output: true },
];

/** Validate all configured paths; never throws, never creates external dirs. */
export function checkAllPaths(cfg: Config): PathCheck[] {
  const fallbacks = fallbackDirs(cfg);
  const out: PathCheck[] = [];
  for (const { key, label, output } of PATH_LABELS) {
    let configured = String(cfg[key] ?? '');
    let resolved = resolveConfigPath(configured);
    let note = '';
    if (key === 'skillsDir') {
      const eff = effectiveSkillsDir(cfg);
      if (!configured && eff.dir) {
        resolved = eff.dir;
        note = `auto-detected: ${eff.source}`;
      } else if (!configured) {
        note = 'not set — using bundled /examples/skills only';
      }
    }
    if (key === 'dataDir' && resolved) {
      try {
        ensureDir(resolved); // data dir is ours; safe to create
      } catch {
        /* reported below */
      }
    }
    const { status, isDir } = checkDir(resolved);
    let fallback = '';
    if (output && key !== 'dataDir' && status !== 'writable') {
      fallback = fallbacks[key] ?? '';
      note = note || `falling back to ${path.relative(APP_ROOT, fallback) || fallback}`;
    }
    if (resolved && status !== 'missing' && status !== 'not-configured' && !isDir) {
      note = (note ? note + '; ' : '') + 'path exists but is not a directory';
    }
    out.push({ key, label, configured, resolved, status, isDir, note, fallback });
  }
  return out;
}

/**
 * Effective output directory for a workflow destination: the configured
 * folder when one applies and is writable, otherwise a subfolder of the
 * local data dir named by the destination.
 */
export function workflowOutputDir(
  cfg: Config,
  dest: { configKey?: 'dailyLogDir' | 'weeklyReportDir' | 'wikiSourceDir'; fallbackSubdir: string },
): { dir: string; usedFallback: boolean } {
  if (dest.configKey) {
    const configured = resolveConfigPath(String(cfg[dest.configKey] ?? ''));
    if (configured && checkDir(configured).status === 'writable') {
      return { dir: configured, usedFallback: false };
    }
  }
  const fb = path.join(dataDir(cfg), dest.fallbackSubdir);
  ensureDir(fb);
  return { dir: fb, usedFallback: true };
}

/** All roots the app is allowed to READ files from (for previews). */
export function allowedReadRoots(cfg: Config): string[] {
  const roots = [dataDir(cfg), EXAMPLES_SKILLS_DIR];
  const eff = effectiveSkillsDir(cfg);
  if (eff.dir) roots.push(eff.dir);
  for (const k of ['obsidianVaultDir', 'dailyLogDir', 'weeklyReportDir', 'wikiSourceDir'] as const) {
    const p = resolveConfigPath(String(cfg[k] ?? ''));
    if (p) roots.push(p);
  }
  return roots;
}

/** All roots the app is allowed to WRITE into. */
export function allowedWriteRoots(cfg: Config): string[] {
  const roots = [dataDir(cfg)];
  for (const k of ['dailyLogDir', 'weeklyReportDir', 'wikiSourceDir'] as const) {
    const p = resolveConfigPath(String(cfg[k] ?? ''));
    if (p) roots.push(p);
  }
  return roots;
}

export function isInsideRoot(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function isPathAllowed(target: string, roots: string[]): boolean {
  return roots.some((r) => r && (path.resolve(r) === path.resolve(target) || isInsideRoot(r, target)));
}

/**
 * Safety gate for every artifact write: refuses paths outside allowed write
 * roots. Returns the final path actually written (de-duplicated filename).
 */
export function safeWriteFile(cfg: Config, targetDir: string, filename: string, content: string): string {
  const dir = path.resolve(targetDir);
  if (!isPathAllowed(dir, allowedWriteRoots(cfg))) {
    throw new Error(`Refusing to write outside configured output folders: ${dir}`);
  }
  ensureDir(dir);
  const base = filename.replace(/[<>:"|?*\\/]/g, '-');
  let finalPath = path.join(dir, base);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let n = 2;
  while (fs.existsSync(finalPath)) {
    finalPath = path.join(dir, `${stem}-${n}${ext}`);
    n++;
  }
  fs.writeFileSync(finalPath, content, 'utf8');
  return finalPath;
}

/** List markdown files (non-recursive) in a dir; [] if missing/unreadable. */
export function listMarkdownFiles(dir: string): Array<{ name: string; path: string; mtimeMs: number }> {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => {
        const p = path.join(dir, e.name);
        return { name: e.name, path: p, mtimeMs: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  } catch {
    return [];
  }
}
