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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConfigSchema, ProfileSchema, dataDir, loadConfig, saveLocalConfig, saveProfiles, type LoadedConfig, type Profile } from './config.ts';
import { allowedReadRoots, checkAllPaths, isPathAllowed } from './paths.ts';
import { loadSkills } from './skills.ts';
import { getProviders } from './providers/index.ts';
import { getStore } from './store.ts';
import { listInboxNotes, listSourceFiles, saveInboxNote, startLabRun, startWorkflowRun } from './workflows.ts';
import { executeApproval, proposeGitCommit, proposeObsidianWrite } from './actions.ts';
import { listEvalSuites, runEvalSuite } from './evals.ts';
import { latestBrief, writeBrief } from './brief.ts';
import { ARCHITECTURE_MODE, WORKFLOWS, allowedWorkflows, getWorkflow, isWorkflowAllowed, modeWorkflows } from './workflowDefs.ts';
import { getRunStream } from './runStream.ts';
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
const WorkflowRunSchema = z.object({
  workflowId: z.string().min(1),
  noteText: z.string().optional(),
  inboxFile: z.string().optional(),
  files: z.array(z.string()).optional(),
  label: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2}|\d{4}-W\d{2})?$/, 'Label must be YYYY-MM-DD or YYYY-Www.')
    .optional()
    .transform((v) => v || undefined),
  skillId: z.string().min(1),
  providerId: z.string().min(1),
  model: ModelSchema,
});
const InboxSchema = z.object({ text: z.string().min(1, 'Note text is empty.') });
const LabRunSchema = z.object({
  skillId: z.string().min(1),
  providerIds: z.array(z.string().min(1)).min(1, 'Pick at least one provider.'),
  inputText: z.string().min(1, 'Sample input is empty.'),
  model: ModelSchema,
});
const SkillPrefSchema = z.object({
  skillId: z.string().min(1),
  providerId: z.string().min(1),
  model: z
    .string()
    .regex(/^[A-Za-z0-9._:-]{0,64}$/, 'Model may only contain letters, digits, . _ : -')
    .default(''),
});
const GoldenSchema = z.object({ skillId: z.string().min(1), runId: z.string().min(1), note: z.string().default('') });
const GoldenDeleteSchema = z.object({ id: z.string().min(1) });
const ScoreSchema = z.object({
  runId: z.string().min(1),
  score: z.enum(['good', 'okay', 'bad']),
  note: z.string().default(''),
});
const ProposeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('obsidian-write'),
    artifactPath: z.string().min(1),
    subdir: z.string().max(200).default('inbox'),
    filename: z.string().max(200).default(''),
  }),
  z.object({ type: z.literal('git-commit'), message: z.string().min(1).max(500) }),
]);
const DecideSchema = z.object({ id: z.string().min(1), decision: z.enum(['approve', 'reject']) });
const EvalRunSchema = z.object({
  suiteId: z.string().min(1),
  skillId: z.string().min(1),
  providerId: z.string().min(1),
  model: ModelSchema,
});

// --- Route handlers ----------------------------------------------------------
type Handler = (ctx: Ctx) => Promise<{ status?: number; html?: string; json?: unknown; redirect?: string }>;

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
        activeProfile: cfg.activeProfile,
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

  'GET /workflows': async ({ cfg }) => ({ html: ui.pageWorkflows({ workflows: allowedWorkflows(cfg) }) }),

  'GET /architecture': async ({ cfg }) => {
    const { skills } = loadSkills(cfg);
    const skillCounts: Record<string, number> = {};
    for (const s of skills) skillCounts[s.kind] = (skillCounts[s.kind] ?? 0) + 1;
    return { html: ui.pageMode({ mode: ARCHITECTURE_MODE, workflows: modeWorkflows(ARCHITECTURE_MODE), skillCounts }) };
  },

  'GET /workflow': async ({ cfg, url }) => {
    const def = getWorkflow(url.searchParams.get('id') ?? '');
    if (!def || !isWorkflowAllowed(cfg, def.id)) return { redirect: '/workflows' };
    const { skills } = loadSkills(cfg);
    return {
      html: ui.pageWorkflowRun({
        def,
        skills,
        defaultProvider: cfg.defaultProvider,
        files: listSourceFiles(cfg, def.inputSource.fileTypes),
        inboxNotes: listInboxNotes(cfg),
        preselectSkill: url.searchParams.get('skill') ?? undefined,
      }),
    };
  },

  // Legacy page URLs from the three-workflow era.
  'GET /inbox': async ({ url }) => ({ redirect: `/workflow?id=daily-log${url.searchParams.get('skill') ? `&skill=${url.searchParams.get('skill')}` : ''}` }),
  'GET /weekly': async () => ({ redirect: '/workflow?id=weekly-report' }),
  'GET /wiki': async () => ({ redirect: '/workflow?id=wiki-source' }),

  'GET /lab': async ({ cfg }) => {
    const { skills } = loadSkills(cfg);
    const store = getStore(dataDir(cfg));
    const versionCounts: Record<string, number> = {};
    for (const s of skills) {
      store.upsertSkillSighting(s);
      versionCounts[s.id] = store.skillVersionCount(s.id);
    }
    const prefs = Object.fromEntries(store.listSkillPrefs().map((p) => [p.skill_id, p]));
    const goldenCounts: Record<string, number> = {};
    for (const g of store.listGoldenExamples()) goldenCounts[g.skill_id] = (goldenCounts[g.skill_id] ?? 0) + 1;
    return { html: ui.pageLab({ skills, versionCounts, prefs, goldenCounts }) };
  },

  'GET /lab/skill': async ({ cfg, url }) => {
    const { skills } = loadSkills(cfg);
    const skill = skills.find((s) => s.id === url.searchParams.get('id'));
    if (!skill) return { redirect: '/lab' };
    const store = getStore(dataDir(cfg));
    store.upsertSkillSighting(skill);
    const labRuns = store.listRuns(500).filter((r) => r.skill_id === skill.id && r.input_source === 'skill-lab').slice(0, 20);
    const scores = Object.fromEntries(labRuns.map((r) => [r.id, store.getRunScore(r.id)?.score ?? '']));
    return {
      html: ui.pageLabSkill({
        skill,
        versions: store.listSkillVersions(skill.id),
        pref: store.getSkillPref(skill.id),
        golden: store.listGoldenExamples(skill.id),
        labRuns,
        scores,
      }),
    };
  },

  'POST /api/lab/run': async ({ cfg, body }) => {
    const args = LabRunSchema.parse(body ?? {});
    const providerIds = [...new Set(args.providerIds)];
    const comparisonId = providerIds.length > 1 ? crypto.randomUUID() : '';
    const runs: Array<{ providerId: string; runId: string }> = [];
    for (const providerId of providerIds) {
      const result = startLabRun(cfg, { skillId: args.skillId, providerId, inputText: args.inputText, model: args.model, comparisonId });
      if ('error' in result) return { status: 400, json: result };
      runs.push({ providerId, runId: result.runId });
    }
    return { status: 202, json: { comparisonId, runs } };
  },

  'GET /api/lab/comparison': async ({ cfg, url }) => {
    const store = getStore(dataDir(cfg));
    const runs = store.listRunsByComparison(url.searchParams.get('id') ?? '');
    return {
      json: {
        runs: runs.map((r) => {
          let outputLength: number | null = null;
          if (r.output_artifact_path) {
            try {
              outputLength = fs.statSync(r.output_artifact_path).size;
            } catch {
              /* unreadable — leave null */
            }
          }
          return {
            ...r,
            score: store.getRunScore(r.id)?.score ?? '',
            durationMs: r.completed_at ? new Date(r.completed_at).getTime() - new Date(r.created_at).getTime() : null,
            outputLength,
          };
        }),
      },
    };
  },

  'GET /shootout': async ({ cfg }) => {
    const { skills } = loadSkills(cfg);
    const store = getStore(dataDir(cfg));
    const providers = await providerHealth(cfg);
    return {
      html: ui.pageShootout({
        skills,
        providers,
        defaultProvider: cfg.defaultProvider,
        history: store.listComparisons(15),
      }),
    };
  },

  'POST /api/shootout': async ({ cfg, body }) => {
    const args = LabRunSchema.parse(body ?? {});
    const providerIds = [...new Set(args.providerIds)];
    if (providerIds.length < 2) return { status: 400, json: { error: 'Pick at least two providers to compare.' } };
    const comparisonId = crypto.randomUUID();
    const runs: Array<{ providerId: string; runId: string }> = [];
    for (const providerId of providerIds) {
      const result = startLabRun(cfg, {
        skillId: args.skillId,
        providerId,
        inputText: args.inputText,
        model: args.model,
        comparisonId,
        mode: 'shootout',
      });
      if ('error' in result) return { status: 400, json: result };
      runs.push({ providerId, runId: result.runId });
    }
    getStore(dataDir(cfg)).audit('shootout.started', { comparisonId, skillId: args.skillId, providers: providerIds });
    return { status: 202, json: { comparisonId, runs } };
  },

  'POST /api/lab/prefs': async ({ cfg, body }) => {
    const args = SkillPrefSchema.parse(body ?? {});
    const store = getStore(dataDir(cfg));
    store.setSkillPref(args.skillId, args.providerId, args.model);
    store.audit('skill.pref_set', { skillId: args.skillId, providerId: args.providerId, model: args.model });
    return { json: { ok: true } };
  },

  'POST /api/lab/golden': async ({ cfg, body }) => {
    const args = GoldenSchema.parse(body ?? {});
    const store = getStore(dataDir(cfg));
    const run = store.getRun(args.runId);
    if (!run) return { status: 404, json: { error: 'Run not found.' } };
    if (run.status !== 'completed' || !run.output_artifact_path) {
      return { status: 400, json: { error: 'Only completed runs with an artifact can become golden examples.' } };
    }
    let output = '';
    try {
      output = readAllowedFile(cfg, run.output_artifact_path);
    } catch (e) {
      return { status: 400, json: { error: `Artifact not readable: ${(e as Error).message}` } };
    }
    const golden = store.addGoldenExample({
      skill_id: run.skill_id,
      skill_hash: run.skill_hash,
      run_id: run.id,
      input_text: run.input_text,
      output_text: output,
      note: args.note,
    });
    store.audit('skill.golden_saved', { skillId: run.skill_id, runId: run.id, goldenId: golden.id });
    return { json: { ok: true, id: golden.id } };
  },

  'POST /api/lab/golden/delete': async ({ cfg, body }) => {
    const { id } = GoldenDeleteSchema.parse(body ?? {});
    const store = getStore(dataDir(cfg));
    store.deleteGoldenExample(id);
    store.audit('skill.golden_deleted', { goldenId: id });
    return { json: { ok: true } };
  },

  'POST /api/runs/score': async ({ cfg, body }) => {
    const args = ScoreSchema.parse(body ?? {});
    const store = getStore(dataDir(cfg));
    const run = store.getRun(args.runId);
    if (!run) return { status: 404, json: { error: 'Run not found.' } };
    store.scoreRun(run.id, run.skill_id, args.score, args.note);
    store.audit('run.scored', { runId: run.id, score: args.score });
    return { json: { ok: true } };
  },

  'GET /profiles': async ({ cfg }) => ({
    html: ui.pageProfiles({
      profiles: cfg.profiles,
      activeProfileId: cfg.activeProfileId,
      workflows: WORKFLOWS,
    }),
  }),

  'GET /api/profiles': async ({ cfg }) => ({
    json: { profiles: cfg.profiles, activeProfileId: cfg.activeProfileId },
  }),

  'POST /api/profiles': async ({ cfg, body }) => {
    const profile = ProfileSchema.parse(body ?? {});
    const rest = cfg.profiles.filter((p) => p.id !== profile.id);
    saveProfiles({ profiles: [...rest, profile] });
    getStore(dataDir(cfg)).audit('profile.saved', { id: profile.id, name: profile.name });
    return { json: { ok: true } };
  },

  'POST /api/profiles/delete': async ({ cfg, body }) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(body ?? {});
    saveProfiles({
      profiles: cfg.profiles.filter((p) => p.id !== id),
      activeProfileId: cfg.activeProfileId === id ? '' : cfg.activeProfileId,
    });
    getStore(dataDir(cfg)).audit('profile.deleted', { id });
    return { json: { ok: true } };
  },

  'POST /api/profiles/activate': async ({ cfg, body }) => {
    const { id } = z.object({ id: z.string().default('') }).parse(body ?? {});
    if (id && !cfg.profiles.some((p) => p.id === id)) return { status: 404, json: { error: `No such profile: ${id}` } };
    saveProfiles({ activeProfileId: id });
    getStore(dataDir(cfg)).audit('profile.activated', { id: id || '(base config)' });
    return { json: { ok: true } };
  },

  'POST /api/profiles/seed': async ({ cfg }) => {
    const existing = new Set(cfg.profiles.map((p) => p.id));
    const seeds = EXAMPLE_PROFILES.filter((p) => !existing.has(p.id));
    if (!seeds.length) return { json: { ok: true, added: 0 } };
    saveProfiles({ profiles: [...cfg.profiles, ...seeds] });
    getStore(dataDir(cfg)).audit('profile.seeded', { added: seeds.map((p) => p.id) });
    return { json: { ok: true, added: seeds.length } };
  },

  'GET /brief': async ({ cfg }) => ({ html: ui.pageBrief({ latest: latestBrief(cfg) }) }),

  'POST /api/brief': async ({ cfg }) => {
    const { path: written } = writeBrief(cfg);
    return { json: { ok: true, path: written } };
  },

  'GET /evals': async ({ cfg }) => {
    const { skills } = loadSkills(cfg);
    const store = getStore(dataDir(cfg));
    return {
      html: ui.pageEvals({
        suites: listEvalSuites(cfg),
        skills,
        defaultProvider: cfg.defaultProvider,
        history: store.listEvalRuns(40),
      }),
    };
  },

  'POST /api/evals/run': async ({ cfg, body }) => {
    const args = EvalRunSchema.parse(body ?? {});
    const result = await runEvalSuite(cfg, args);
    if ('error' in result) return { status: 400, json: result };
    return { json: result };
  },

  'GET /api/evals/suites': async ({ cfg }) => ({
    json: { suites: listEvalSuites(cfg).map(({ rubric, ...s }) => ({ ...s, hasRubric: !!rubric })) },
  }),

  'GET /approvals': async ({ cfg }) => {
    const store = getStore(dataDir(cfg));
    return {
      html: ui.pageApprovals({
        approvals: store.listApprovals(),
        vaultConfigured: !!cfg.obsidianVaultDir,
        gitRepoConfigured: !!cfg.gitRepoDir,
      }),
    };
  },

  'POST /api/actions/propose': async ({ cfg, body }) => {
    const args = ProposeSchema.parse(body ?? {});
    const allowedActions = cfg.activeProfile?.approvalActions ?? ['obsidian-write', 'git-commit'];
    if (!allowedActions.includes(args.type)) {
      return { status: 403, json: { error: `Action "${args.type}" is not allowed by the active profile.` } };
    }
    const result =
      args.type === 'obsidian-write'
        ? proposeObsidianWrite(cfg, { artifactPath: args.artifactPath, subdir: args.subdir, filename: args.filename || undefined })
        : await proposeGitCommit(cfg, { message: args.message });
    if ('error' in result) return { status: 400, json: result };
    return { status: 201, json: { ok: true, id: result.id, target: result.target } };
  },

  'GET /api/approvals': async ({ cfg }) => ({ json: { approvals: getStore(dataDir(cfg)).listApprovals() } }),

  'POST /api/approvals/decide': async ({ cfg, body }) => {
    const args = DecideSchema.parse(body ?? {});
    const result = await executeApproval(cfg, args.id, args.decision);
    return { status: result.ok ? 200 : 422, json: result };
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

  'GET /api/workflows': async ({ cfg }) => ({ json: { workflows: allowedWorkflows(cfg) } }),

  'POST /api/run/workflow': async ({ cfg, body }) => {
    const args = WorkflowRunSchema.parse(body ?? {});
    if (!isWorkflowAllowed(cfg, args.workflowId)) {
      return { status: 403, json: { error: `Workflow "${args.workflowId}" is not allowed by the active profile.` } };
    }
    const result = startWorkflowRun(cfg, args);
    if ('error' in result) return { status: 400, json: result };
    return { status: 202, json: result };
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

// Example profiles seeded on demand from the Profiles page. Paths are left
// blank on purpose — they're machine-specific and filled in per clone.
const EXAMPLE_PROFILES: Profile[] = [
  {
    id: 'work-notes', name: 'Work Notes', description: 'Daily logs and weekly reports for the day job.',
    skillsDir: '', obsidianVaultDir: '', dailyLogDir: '', weeklyReportDir: '', wikiSourceDir: '', gitRepoDir: '',
    defaultProvider: '', allowedWorkflows: ['daily-log', 'weekly-report', 'one-on-one-prep', 'sprint-planning'],
    approvalActions: ['obsidian-write'],
  },
  {
    id: 'ai-architecture', name: 'AI Architecture', description: 'Canon, ADRs, roadmap, review packets — the architecture artifact factory.',
    skillsDir: '', obsidianVaultDir: '', dailyLogDir: '', weeklyReportDir: '', wikiSourceDir: '', gitRepoDir: '',
    defaultProvider: '', allowedWorkflows: ARCHITECTURE_MODE.workflowIds.concat('wiki-source'),
    approvalActions: ['obsidian-write', 'git-commit'],
  },
  {
    id: 'fable', name: 'Fable', description: 'Generated docs, QA critique, consolidation of AI output.',
    skillsDir: '', obsidianVaultDir: '', dailyLogDir: '', weeklyReportDir: '', wikiSourceDir: '', gitRepoDir: '',
    defaultProvider: '', allowedWorkflows: ['fable-output-qa', 'wiki-source', 'architecture-canon'],
    approvalActions: ['obsidian-write'],
  },
  {
    id: 'book', name: 'Book', description: 'Chapters, outline, tone review.',
    skillsDir: '', obsidianVaultDir: '', dailyLogDir: '', weeklyReportDir: '', wikiSourceDir: '', gitRepoDir: '',
    defaultProvider: '', allowedWorkflows: ['daily-log', 'fable-output-qa'], approvalActions: ['obsidian-write', 'git-commit'],
  },
  {
    id: 'zaxis', name: 'Zaxis', description: 'Pi survival assistant docs and checklists.',
    skillsDir: '', obsidianVaultDir: '', dailyLogDir: '', weeklyReportDir: '', wikiSourceDir: '', gitRepoDir: '',
    defaultProvider: '', allowedWorkflows: ['daily-log', 'roadmap-to-backlog'], approvalActions: ['git-commit'],
  },
  {
    id: 'grocery-hermes', name: 'Grocery/Hermes', description: 'Household automation notes.',
    skillsDir: '', obsidianVaultDir: '', dailyLogDir: '', weeklyReportDir: '', wikiSourceDir: '', gitRepoDir: '',
    defaultProvider: '', allowedWorkflows: ['daily-log', 'sprint-planning'], approvalActions: [],
  },
  {
    id: 'trading-coach', name: 'Trading Coach', description: 'Daily market notes, lessons learned.',
    skillsDir: '', obsidianVaultDir: '', dailyLogDir: '', weeklyReportDir: '', wikiSourceDir: '', gitRepoDir: '',
    defaultProvider: '', allowedWorkflows: ['daily-log', 'weekly-report'], approvalActions: [],
  },
];

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

const RUN_STREAM_RE = /^\/api\/runs\/([0-9a-fA-F-]{1,64})\/stream$/;

// Server-Sent Events for a single run's live output. Handled outside the
// routes table since it holds the connection open and writes incrementally
// instead of returning one {status, html|json} value.
function handleRunStreamSse(runId: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const stream = getRunStream(runId);
  if (!stream) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Run not found or no longer streaming.' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const writeLine = (line: string) => res.write(`data: ${JSON.stringify(line)}\n\n`);
  const writeDone = (result: unknown) => res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);

  if (stream.done) {
    for (const line of stream.bufferedLines()) writeLine(line);
    writeDone(stream.result);
    res.end();
    return;
  }

  const onLine = (line: string) => writeLine(line);
  const onDone = (result: unknown) => {
    writeDone(result);
    res.end();
  };
  // Subscribe first, then replay what's already buffered — since Node runs
  // single-threaded, nothing can emit between the subscribe call and the
  // synchronous replay loop below, so no lines are missed or duplicated.
  stream.on('line', onLine);
  stream.on('done', onDone);
  for (const line of stream.bufferedLines()) writeLine(line);

  const heartbeat = setInterval(() => res.write(':heartbeat\n\n'), 15_000);
  const cleanup = () => {
    clearInterval(heartbeat);
    stream.off('line', onLine);
    stream.off('done', onDone);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

const server = http.createServer(async (req, res) => {
  const cfg = loadConfig(); // re-read each request so Settings saves apply live
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  const streamMatch = req.method === 'GET' ? url.pathname.match(RUN_STREAM_RE) : null;
  if (streamMatch) {
    handleRunStreamSse(streamMatch[1], req, res);
    return;
  }

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
    if (result.redirect !== undefined) {
      res.writeHead(302, { Location: result.redirect });
      res.end();
      return;
    }
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
