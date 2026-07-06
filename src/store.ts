import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './paths.ts';

// node:sqlite ships with Node >= 22.5 (no flag needed on 23.4+). If it's not
// available we degrade to a JSON file store so the app still runs everywhere.
let DatabaseSync: (new (p: string) => any) | null = null;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  DatabaseSync = null;
}

export type RunRecord = {
  id: string;
  skill_id: string;
  skill_name: string;
  skill_path: string;
  skill_hash: string;
  provider_id: string;
  input_source: string; // 'pasted' | 'inbox-file' | 'daily-logs' | ...
  input_text: string;
  input_files: string[]; // file paths used as input
  output_artifact_path: string;
  artifact_type: string; // daily-log | weekly-report | wiki-source
  status: 'running' | 'completed' | 'error';
  created_at: string;
  completed_at: string;
  error: string;
  provider_command: string; // exact CLI command line minus the prompt body
};

export type ArtifactRecord = {
  id: string;
  run_id: string;
  type: string;
  path: string;
  title: string;
  created_at: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, name TEXT, path TEXT, source TEXT, first_seen TEXT
);
CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY, skill_id TEXT, hash TEXT, seen_at TEXT
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT, capabilities TEXT, last_health TEXT, checked_at TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, skill_id TEXT, skill_name TEXT, skill_path TEXT, skill_hash TEXT,
  provider_id TEXT, input_source TEXT, input_text TEXT, input_files TEXT,
  output_artifact_path TEXT, artifact_type TEXT, status TEXT,
  created_at TEXT, completed_at TEXT, error TEXT, provider_command TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, run_id TEXT, type TEXT, path TEXT, title TEXT, created_at TEXT
);
CREATE TABLE IF NOT EXISTS config_paths (
  key TEXT PRIMARY KEY, path TEXT, status TEXT, checked_at TEXT
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, action TEXT, target TEXT, status TEXT, created_at TEXT, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY, ts TEXT, event_type TEXT, detail TEXT
);
`;

const JSON_TABLES = [
  'skills',
  'skill_versions',
  'providers',
  'runs',
  'artifacts',
  'config_paths',
  'approvals',
  'audit_events',
] as const;
type TableName = (typeof JSON_TABLES)[number];

function now(): string {
  return new Date().toISOString();
}

export class Store {
  readonly backend: 'sqlite' | 'json';
  readonly dbPath: string;
  private db: any = null;
  private jsonData: Record<TableName, Record<string, unknown>[]> | null = null;
  private jsonPath = '';

  constructor(dataDirPath: string) {
    ensureDir(dataDirPath);
    this.dbPath = path.join(dataDirPath, 'workbench.db');
    this.jsonPath = path.join(dataDirPath, 'workbench-meta.json');
    if (DatabaseSync) {
      this.db = new DatabaseSync(this.dbPath);
      this.db.exec(SCHEMA);
      // migration for DBs created before provider_command existed
      try {
        this.db.exec(`ALTER TABLE runs ADD COLUMN provider_command TEXT DEFAULT ''`);
      } catch {
        /* column already exists */
      }
      this.backend = 'sqlite';
    } else {
      this.backend = 'json';
      this.jsonData = this.loadJson();
    }
  }

  private loadJson(): Record<TableName, Record<string, unknown>[]> {
    const empty = Object.fromEntries(JSON_TABLES.map((t) => [t, []])) as Record<
      TableName,
      Record<string, unknown>[]
    >;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.jsonPath, 'utf8'));
      return { ...empty, ...parsed };
    } catch {
      return empty;
    }
  }

  private saveJson(): void {
    fs.writeFileSync(this.jsonPath, JSON.stringify(this.jsonData, null, 1), 'utf8');
  }

  // --- tiny generic table layer -------------------------------------------
  private insert(table: TableName, row: Record<string, unknown>): void {
    if (this.db) {
      const keys = Object.keys(row);
      const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
      this.db.prepare(sql).run(...keys.map((k) => row[k]));
    } else {
      const rows = this.jsonData![table];
      const idx = rows.findIndex((r) => r.id === row.id || (table === 'config_paths' && r.key === row.key));
      if (idx >= 0) rows[idx] = row;
      else rows.push(row);
      this.saveJson();
    }
  }

  private updateById(table: TableName, id: string, patch: Record<string, unknown>): void {
    if (this.db) {
      const keys = Object.keys(patch);
      if (!keys.length) return;
      const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
      this.db.prepare(sql).run(...keys.map((k) => patch[k]), id);
    } else {
      const row = this.jsonData![table].find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      this.saveJson();
    }
  }

  private selectAll(table: TableName): Record<string, unknown>[] {
    if (this.db) return this.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    return [...this.jsonData![table]];
  }

  // --- domain methods -------------------------------------------------------
  audit(eventType: string, detail: Record<string, unknown>): void {
    this.insert('audit_events', {
      id: crypto.randomUUID(),
      ts: now(),
      event_type: eventType,
      detail: JSON.stringify(detail),
    });
  }

  upsertSkillSighting(skill: { id: string; name: string; path: string; source: string; hash: string }): void {
    const existing = this.selectAll('skills').find((s) => s.id === skill.id);
    if (!existing) {
      this.insert('skills', {
        id: skill.id,
        name: skill.name,
        path: skill.path,
        source: skill.source,
        first_seen: now(),
      });
    }
    const versions = this.selectAll('skill_versions');
    if (!versions.some((v) => v.skill_id === skill.id && v.hash === skill.hash)) {
      this.insert('skill_versions', {
        id: crypto.randomUUID(),
        skill_id: skill.id,
        hash: skill.hash,
        seen_at: now(),
      });
    }
  }

  skillVersionCount(skillId: string): number {
    return this.selectAll('skill_versions').filter((v) => v.skill_id === skillId).length;
  }

  recordProviderHealth(id: string, name: string, capabilities: string[], health: string): void {
    this.insert('providers', {
      id,
      name,
      capabilities: JSON.stringify(capabilities),
      last_health: health,
      checked_at: now(),
    });
  }

  setConfigPathStatus(key: string, p: string, status: string): void {
    this.insert('config_paths', { key, path: p, status, checked_at: now() });
  }

  createRun(run: Omit<RunRecord, 'created_at' | 'completed_at'>): RunRecord {
    const full: RunRecord = { ...run, created_at: now(), completed_at: '' };
    this.insert('runs', { ...full, input_files: JSON.stringify(full.input_files) });
    return full;
  }

  completeRun(id: string, patch: { output_artifact_path: string; provider_command?: string }): void {
    this.updateById('runs', id, {
      output_artifact_path: patch.output_artifact_path,
      provider_command: patch.provider_command ?? '',
      status: 'completed',
      completed_at: now(),
    });
  }

  failRun(id: string, error: string, providerCommand?: string): void {
    this.updateById('runs', id, {
      error,
      provider_command: providerCommand ?? '',
      status: 'error',
      completed_at: now(),
    });
  }

  private rowToRun(r: Record<string, unknown>): RunRecord {
    let files: string[] = [];
    try {
      files = JSON.parse(String(r.input_files || '[]'));
    } catch {
      /* ignore */
    }
    return { ...(r as unknown as RunRecord), input_files: files, provider_command: String(r.provider_command ?? '') };
  }

  getRun(id: string): RunRecord | null {
    const row = this.selectAll('runs').find((r) => r.id === id);
    return row ? this.rowToRun(row) : null;
  }

  listRuns(limit = 100): RunRecord[] {
    return this.selectAll('runs')
      .map((r) => this.rowToRun(r))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, limit);
  }

  addArtifact(a: Omit<ArtifactRecord, 'id' | 'created_at'>): ArtifactRecord {
    const full: ArtifactRecord = { ...a, id: crypto.randomUUID(), created_at: now() };
    this.insert('artifacts', { ...full });
    return full;
  }

  listArtifacts(type?: string): ArtifactRecord[] {
    return (this.selectAll('artifacts') as unknown as ArtifactRecord[])
      .filter((a) => !type || a.type === type)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }

  getArtifact(id: string): ArtifactRecord | null {
    return (this.selectAll('artifacts') as unknown as ArtifactRecord[]).find((a) => a.id === id) ?? null;
  }
}

let storeInstance: Store | null = null;
let storeDir = '';

/** Singleton store, re-created if the data dir setting changes. */
export function getStore(dataDirPath: string): Store {
  if (!storeInstance || storeDir !== dataDirPath) {
    storeInstance = new Store(dataDirPath);
    storeDir = dataDirPath;
  }
  return storeInstance;
}
