// Require Node 24+: native TypeScript execution and stable node:sqlite.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) {
  console.error(
    `Agentic Workbench requires Node.js 24 or higher (you are running ${process.version}).\n` +
      'Install Node 24 LTS from https://nodejs.org or via nvm/winget, then re-run npm run dev.',
  );
  process.exit(1);
}

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConfigSchema, dataDir, loadConfig, saveLocalConfig, type LoadedConfig } from './config.ts';
import { allowedReadRoots, checkAllPaths, isPathAllowed } from './paths.ts';
import { loadSkills } from './skills.ts';
import { getProviders } from './providers/index.ts';
import { getStore } from './store.ts';
import {
  listDailyLogs,
  listInboxNotes,
  listWeeklyReports,
  runDailyLog,
  runWeeklyReport,
  runWikiSource,
  saveInboxNote,
} from './workflows.ts';
import * as ui from './ui.ts';

type Ctx = {
  cfg: LoadedConfig;
  url: URL;
  body: unknown;
};

async function providerHealth(cfg: LoadedConfig) {
  const providers = getProviders(cfg);
  const store = getStore(dataDir(cfg));
  const results = await Promise.all(
    Object.values(providers).map(async (p) => {
      const h = await p.healthCheck();
      store.recordProviderHealth(p.id, p.name, p.capabilities, h.healthy ? 'healthy' : 'unavailable');
      return { id: p.id, name: p.name, capabilities: p.capabilities, ...h };
    }),
  );
  return results;
}

function recordPathStatuses(cfg: LoadedConfig) {
  const store = getStore(dataDir(cfg));
  const paths = checkAllPaths(cfg);
  for (const p of paths) store.setConfigPathStatus(p.key, p.resolved, p.status);
  return paths;
}

function readAllowedFile(cfg: LoadedConfig, p: string): string {
  const resolved = path.resolve(p);
  if (!isPathAllowed(resolved, allowedReadRoots(cfg))) {
    throw new Error('Path is outside the folders this app is allowed to read.');
  }
  return fs.readFileSync(resolved, 'utf8');
}

// --- API input schemas -------------------------------------------------------
const ModelSchema = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{0,64}$/, 'Model may only contain letters, digits, . _ : -')
  .optional()
  .transform((v) => v || undefined);
const DailyRunSchema = z.object({
  noteText: z.string().optional(),
  inboxFile: z.string().optional(),
  skillId: z.string().min(1),
  providerId: z.string().min(1),
  model: ModelSchema,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('').transform(() => undefined)),
});
const WeeklyRunSchema = z.object({
  week: z.string().default(''),
  files: z.array(z.string()).min(1, 'Select at least one daily log.'),
  skillId: z.string().min(1),
  providerId: z.string().min(1),
  model: ModelSchema,
});
const WikiRunSchema = z.object({
  files: z.array(z.string()).min(1, 'Select at least one source note.'),
  skillId: z.string().min(1),
  providerId: z.string().min(1),
  model: ModelSchema,
});
const InboxSchema = z.object({ text: z.string().min(1, 'Note text is empty.') });

// --- Route handlers ----------------------------------------------------------
type Handler = (ctx: Ctx) => Promise<{ status?: number; html?: string; json?: unknown }>;

const routes: Record<string, Handler> = {
  'GET /': async ({ cfg }) => {
    const paths = recordPathStatuses(cfg);
    const providers = await providerHealth(cfg);
    const store = getStore(dataDir(cfg));
    const { skills } = loadSkills(cfg);
    const needsSetup = !cfg.dailyLogDir && !cfg.obsidianVaultDir && !cfg.skillsDir;
    return {
      html: ui.pageDashboard({
        needsSetup,
        paths,
        providers,
        runs: store.listRuns(5),
        artifacts: store.listArtifacts().slice(0, 5),
        skillCount: skills.length,
        storeBackend: store.backend,
      }),
    };
  },

  'GET /settings': async ({ cfg }) => {
    const paths = recordPathStatuses(cfg);
    const providers = await providerHealth(cfg);
    return { html: ui.pageSettings({ cfg, paths, providers }) };
  },

  'GET /skills': async ({ cfg }) => {
    const { skills, skillsDir, skillsDirSource } = loadSkills(cfg);
    const store = getStore(dataDir(cfg));
    const versionCounts: Record<string, number> = {};
    for (const s of skills) {
      store.upsertSkillSighting(s);
      versionCounts[s.id] = store.skillVersionCount(s.id);
    }
    return { html: ui.pageSkills({ skills, skillsDir, skillsDirSource, versionCounts }) };
  },

  'GET /inbox': async ({ cfg, url }) => {
    const { skills } = loadSkills(cfg);
    return {
      html: ui.pageInbox({
        skills,
        defaultProvider: cfg.defaultProvider,
        inboxNotes: listInboxNotes(cfg),
        preselectSkill: url.searchParams.get('skill') ?? undefined,
      }),
    };
  },

  'GET /weekly': async ({ cfg }) => {
    const { skills } = loadSkills(cfg);
    return { html: ui.pageWeekly({ skills, defaultProvider: cfg.defaultProvider, logs: listDailyLogs(cfg) }) };
  },

  'GET /wiki': async ({ cfg }) => {
    const { skills } = loadSkills(cfg);
    return {
      html: ui.pageWiki({
        skills,
        defaultProvider: cfg.defaultProvider,
        logs: listDailyLogs(cfg),
        reports: listWeeklyReports(cfg),
      }),
    };
  },

  'GET /runs': async ({ cfg }) => {
    const store = getStore(dataDir(cfg));
    return { html: ui.pageRuns({ runs: store.listRuns(200) }) };
  },

  'GET /run': async ({ cfg, url }) => {
    const store = getStore(dataDir(cfg));
    const run = store.getRun(url.searchParams.get('id') ?? '');
    let artifactContent = '';
    if (run?.output_artifact_path) {
      try {
        artifactContent = readAllowedFile(cfg, run.output_artifact_path);
      } catch (e) {
        artifactContent = `(artifact not readable: ${(e as Error).message})`;
      }
    }
    const providers = getProviders(cfg);
    const summary = run ? await providers[run.provider_id as keyof typeof providers]?.summarizeRun(run.id, store) : '';
    return { html: ui.pageRunDetail({ run, summary: summary ?? '', artifactContent }) };
  },

  'GET /artifacts': async ({ cfg, url }) => {
    const store = getStore(dataDir(cfg));
    const filter = url.searchParams.get('type') ?? '';
    const previewPath = url.searchParams.get('preview') ?? '';
    let previewContent = '';
    if (previewPath) {
      try {
        previewContent = readAllowedFile(cfg, previewPath);
      } catch (e) {
        previewContent = `(not readable: ${(e as Error).message})`;
      }
    }
    return {
      html: ui.pageArtifacts({ artifacts: store.listArtifacts(filter || undefined), filter, previewPath, previewContent }),
    };
  },

  // --- JSON API --------------------------------------------------------------
  'GET /api/config': async ({ cfg }) => ({ json: cfg }),

  'POST /api/config': async ({ cfg, body }) => {
    const patch = ConfigSchema.partial().parse(body ?? {});
    const next = saveLocalConfig(patch);
    getStore(dataDir(next)).audit('config.saved', { keys: Object.keys(patch) });
    return { json: { ok: true } };
  },

  'GET /api/paths/validate': async ({ cfg, url }) => {
    // Validate the values currently in the form (unsaved), overlaid on config.
    const overlay: Record<string, unknown> = { ...cfg };
    for (const [k, v] of url.searchParams) if (k in ConfigSchema.shape) overlay[k] = v;
    const parsed = ConfigSchema.safeParse(overlay);
    const effective = parsed.success ? parsed.data : cfg;
    const paths = checkAllPaths(effective);
    return { json: { paths, html: renderPathsFragment(paths) } };
  },

  'GET /api/skills': async ({ cfg }) => {
    const { skills, skillsDir } = loadSkills(cfg);
    return {
      json: {
        skillsDir,
        skills: skills.map(({ raw, body, ...rest }) => rest),
      },
    };
  },

  'GET /api/skills/raw': async ({ cfg, url }) => {
    const id = url.searchParams.get('id') ?? '';
    const { skills } = loadSkills(cfg);
    const skill = skills.find((s) => s.id === id);
    if (!skill) return { status: 404, json: { error: 'Skill not found.' } };
    return { json: { raw: skill.raw, meta: skill.meta, hash: skill.hash, path: skill.path } };
  },

  'GET /api/providers': async ({ cfg }) => ({ json: { providers: await providerHealth(cfg) } }),

  'POST /api/inbox': async ({ cfg, body }) => {
    const { text } = InboxSchema.parse(body ?? {});
    return { json: saveInboxNote(cfg, text) };
  },

  'GET /api/inbox/read': async ({ cfg, url }) => {
    const name = path.basename(url.searchParams.get('name') ?? '');
    const p = path.join(dataDir(cfg), 'inbox', name);
    return { json: { text: readAllowedFile(cfg, p) } };
  },

  'POST /api/run/daily': async ({ cfg, body }) => {
    const args = DailyRunSchema.parse(body ?? {});
    const result = await runDailyLog(cfg, args);
    if ('error' in result && !('runId' in result)) return { status: 400, json: result };
    if ('status' in result && result.status === 'error') return { status: 422, json: { error: result.error, runId: result.runId } };
    return { json: result };
  },

  'POST /api/run/weekly': async ({ cfg, body }) => {
    const args = WeeklyRunSchema.parse(body ?? {});
    const result = await runWeeklyReport(cfg, args);
    if ('error' in result && !('runId' in result)) return { status: 400, json: result };
    if ('status' in result && result.status === 'error') return { status: 422, json: { error: result.error, runId: result.runId } };
    return { json: result };
  },

  'POST /api/run/wiki': async ({ cfg, body }) => {
    const args = WikiRunSchema.parse(body ?? {});
    const result = await runWikiSource(cfg, args);
    if ('error' in result && !('runId' in result)) return { status: 400, json: result };
    if ('status' in result && result.status === 'error') return { status: 422, json: { error: result.error, runId: result.runId } };
    return { json: result };
  },

  'GET /api/runs': async ({ cfg }) => ({ json: { runs: getStore(dataDir(cfg)).listRuns(200) } }),

  'GET /api/artifacts/content': async ({ cfg, url }) => {
    const p = url.searchParams.get('path') ?? '';
    return { json: { content: readAllowedFile(cfg, p) } };
  },

  'GET /api/health': async ({ cfg }) => ({
    json: { ok: true, store: getStore(dataDir(cfg)).backend, node: process.version },
  }),
};

// Minimal fragment renderer for path validation results (reuses ui styles).
function renderPathsFragment(paths: ReturnType<typeof checkAllPaths>): string {
  const badge = (s: string) => {
    const map: Record<string, string> = {
      writable: 'b-ok', 'read-only': 'b-warn', missing: 'b-err', unreadable: 'b-err', 'not-configured': 'b-dim',
    };
    return `<span class="badge ${map[s] ?? 'b-dim'}">${ui.esc(s)}</span>`;
  };
  const rows = paths
    .map(
      (p) => `<tr><td>${ui.esc(p.label)}</td><td class="mono small">${ui.esc(p.resolved || '—')}</td>
<td>${badge(p.status)}</td><td class="dim small">${ui.esc(p.note || '')}${
        p.fallback ? `<br>fallback: <span class="mono">${ui.esc(p.fallback)}</span>` : ''
      }</td></tr>`,
    )
    .join('');
  return `<table><tr><th>Path</th><th>Resolved</th><th>Status</th><th>Notes</th></tr>${rows}</table>`;
}

// --- HTTP plumbing -----------------------------------------------------------
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 5_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : undefined);
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

const cfgBoot = loadConfig();

const server = http.createServer(async (req, res) => {
  const cfg = loadConfig(); // re-read each request so Settings saves apply live
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const key = `${req.method} ${url.pathname}`;
  const handler = routes[key];
  try {
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ui.layout('Not found', '', `<h1>404</h1><p>No route for <code>${ui.esc(key)}</code>. <a href="/">Dashboard</a></p>`));
      return;
    }
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const result = await handler({ cfg, url, body });
    if (result.html !== undefined) {
      res.writeHead(result.status ?? 200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(result.html);
    } else {
      res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(result.json ?? {}));
    }
  } catch (err) {
    const message = err instanceof z.ZodError ? err.issues.map((i) => i.message).join('; ') : (err as Error).message;
    const status = err instanceof z.ZodError ? 400 : 500;
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: message }));
    } else {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(ui.layout('Error', '', `<h1>Something went wrong</h1><pre>${ui.esc(message)}</pre><p><a href="/">Dashboard</a></p>`));
    }
  }
});

server.listen(cfgBoot.port, cfgBoot.host, () => {
  const store = getStore(dataDir(cfgBoot));
  store.audit('server.started', { node: process.version, backend: store.backend });
  console.log(`Agentic Workbench running at http://${cfgBoot.host}:${cfgBoot.port}`);
  console.log(`  metadata store : ${store.backend} (${store.backend === 'sqlite' ? store.dbPath : 'JSON fallback'})`);
  console.log(`  app root       : ${path.resolve(import.meta.dirname, '..')}`);
});
