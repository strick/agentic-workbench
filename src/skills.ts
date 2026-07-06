import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EXAMPLES_SKILLS_DIR, effectiveSkillsDir, type Config } from './config.ts';

export type Skill = {
  id: string; // stable id derived from file path
  name: string;
  description: string;
  path: string;
  relPath: string; // path relative to its source root, for display
  source: 'configured' | 'examples';
  hash: string; // sha256 of file content
  shortHash: string;
  kind: 'daily-log' | 'weekly-report' | 'wiki-source' | 'other';
  meta: Record<string, string>;
  body: string; // markdown body (frontmatter stripped)
  raw: string; // full file content
};

/**
 * Tolerant frontmatter parser: flat `key: value` pairs and `[a, b]` /
 * `- item` lists (flattened to comma-joined strings). Anything it cannot
 * understand is skipped, never thrown.
 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!raw.startsWith('---')) return { meta, body: raw };
  const lines = raw.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return { meta, body: raw };
  let currentKey = '';
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentKey) {
      meta[currentKey] = meta[currentKey] ? `${meta[currentKey]}, ${listItem[1].trim()}` : listItem[1].trim();
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    currentKey = kv[1].toLowerCase();
    let value = kv[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
    value = value.replace(/^["']|["']$/g, '');
    if (value) meta[currentKey] = value;
    else meta[currentKey] = '';
  }
  return { meta, body: lines.slice(end + 1).join('\n').trim() };
}

function guessKind(name: string, meta: Record<string, string>, filePath: string): Skill['kind'] {
  const hay = `${meta.kind ?? ''} ${meta.tags ?? ''} ${name} ${path.basename(filePath)}`.toLowerCase();
  if (/wiki|canon|sanitiz/.test(hay)) return 'wiki-source';
  if (/week/.test(hay)) return 'weekly-report';
  if (/daily|work[- ]?log|day[- ]?log/.test(hay)) return 'daily-log';
  return 'other';
}

function scanDirForMarkdown(root: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) found.push(p);
    }
  };
  walk(root, 0);
  return found.sort();
}

function loadSkillFile(filePath: string, root: string, source: Skill['source']): Skill | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontmatter(raw);
  const fallbackName = path
    .basename(filePath, '.md')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  // Copilot/Claude skill convention: skills/<name>/SKILL.md — use folder name.
  const name =
    meta.name ||
    (path.basename(filePath).toLowerCase() === 'skill.md'
      ? path.basename(path.dirname(filePath)).replace(/[-_]+/g, ' ')
      : fallbackName);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return {
    id: crypto.createHash('sha256').update(`${source}:${filePath}`).digest('hex').slice(0, 16),
    name,
    description: meta.description || body.split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#'))?.trim() || '',
    path: filePath,
    relPath: path.relative(root, filePath) || path.basename(filePath),
    source,
    hash,
    shortHash: hash.slice(0, 12),
    kind: guessKind(name, meta, filePath),
    meta,
    body,
    raw,
  };
}

/**
 * Load all skills: configured skills dir (if resolvable) merged with the
 * bundled examples. Never throws on missing/unreadable folders or files.
 */
export function loadSkills(cfg: Config): { skills: Skill[]; skillsDir: string; skillsDirSource: string } {
  const eff = effectiveSkillsDir(cfg);
  const skills: Skill[] = [];
  if (eff.dir) {
    for (const f of scanDirForMarkdown(eff.dir)) {
      const s = loadSkillFile(f, eff.dir, 'configured');
      if (s) skills.push(s);
    }
  }
  for (const f of scanDirForMarkdown(EXAMPLES_SKILLS_DIR)) {
    const s = loadSkillFile(f, EXAMPLES_SKILLS_DIR, 'examples');
    if (s) skills.push(s);
  }
  skills.sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'configured' ? -1 : 1));
  return { skills, skillsDir: eff.dir, skillsDirSource: eff.source };
}

export function findSkill(cfg: Config, idOrPath: string): Skill | null {
  const { skills } = loadSkills(cfg);
  return skills.find((s) => s.id === idOrPath || s.path === idOrPath) ?? null;
}
