// The general workflow model. A workflow is:
//   Skill + Input Source + Provider + Output Type + Destination + Approval Rule
// The original daily-log / weekly-report / wiki-source flows are now just
// built-in templates in this registry, alongside the newer work-routine
// templates (ADR generator, review board packet, 1:1 prep, ...).
import type { Config } from './config.ts';

/** How a workflow receives its input. */
export type InputSourceKind = 'text' | 'files' | 'text-or-files';

export type WorkflowInputSource = {
  kind: InputSourceKind;
  /** Which artifact/output types feed the file picker (for 'files' / 'text-or-files'). */
  fileTypes: string[];
  /** Human description of the expected input, shown on the run page. */
  label: string;
};

export type WorkflowDestination = {
  /** Config key of a user-configurable output folder, if this output type has one. */
  configKey?: 'dailyLogDir' | 'weeklyReportDir' | 'wikiSourceDir';
  /** Subfolder under the app data dir used when no configured folder applies. */
  fallbackSubdir: string;
};

export type ApprovalRule = 'none'; // future: 'require-approval' for external writes

export type WorkflowDef = {
  id: string;
  name: string;
  description: string;
  /** Grouping for the UI. */
  category: 'core' | 'architecture' | 'planning' | 'quality';
  /** Preferred skill kind — used to preselect a matching skill on the run page. */
  skillKind: string;
  inputSource: WorkflowInputSource;
  /** Artifact type string recorded on runs/artifacts and passed to providers. */
  outputType: string;
  destination: WorkflowDestination;
  /** '{label}' is replaced with the date (YYYY-MM-DD) or week (YYYY-Www). */
  filenamePattern: string;
  /** Whether the run is labeled by calendar date or ISO week. */
  dateMode: 'date' | 'week';
  approvalRule: ApprovalRule;
  builtIn: boolean;
};

export const WORKFLOWS: WorkflowDef[] = [
  {
    id: 'daily-log',
    name: 'Daily Work Log',
    description: 'Turn dictated end-of-day notes into a structured daily markdown log.',
    category: 'core',
    skillKind: 'daily-log',
    inputSource: { kind: 'text', fileTypes: [], label: 'Raw dictated notes (pasted or from a saved inbox note)' },
    outputType: 'daily-log',
    destination: { configKey: 'dailyLogDir', fallbackSubdir: 'daily-logs' },
    filenamePattern: '{label}-daily-log.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'weekly-report',
    name: 'Weekly Director Report',
    description: 'Synthesize a week of daily logs into a director-ready summary.',
    category: 'core',
    skillKind: 'weekly-report',
    inputSource: { kind: 'files', fileTypes: ['daily-log'], label: 'Daily logs for the selected week' },
    outputType: 'weekly-report',
    destination: { configKey: 'weeklyReportDir', fallbackSubdir: 'weekly-reports' },
    filenamePattern: '{label}-weekly-report.md',
    dateMode: 'week',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'wiki-source',
    name: 'Wiki Source Builder',
    description: 'Distill daily logs and weekly reports into a sanitized wiki/canon source note.',
    category: 'core',
    skillKind: 'wiki-source',
    inputSource: { kind: 'files', fileTypes: ['daily-log', 'weekly-report'], label: 'Daily logs and weekly reports to distill' },
    outputType: 'wiki-source',
    destination: { configKey: 'wikiSourceDir', fallbackSubdir: 'wiki-source' },
    filenamePattern: '{label}-wiki-source.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'architecture-canon',
    name: 'Architecture Canon Update',
    description: 'Distill work logs and architecture notes into a sanitized canon note.',
    category: 'architecture',
    skillKind: 'canon-note',
    inputSource: {
      kind: 'text-or-files',
      fileTypes: ['daily-log', 'weekly-report', 'wiki-source'],
      label: 'Work logs and/or pasted architecture notes',
    },
    outputType: 'canon-note',
    destination: { fallbackSubdir: 'canon-notes' },
    filenamePattern: '{label}-canon-note.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'adr',
    name: 'ADR Generator',
    description: 'Turn rough decision notes into a formal Architecture Decision Record.',
    category: 'architecture',
    skillKind: 'adr',
    inputSource: { kind: 'text', fileTypes: [], label: 'Rough decision notes: context, options considered, decision, consequences' },
    outputType: 'adr',
    destination: { fallbackSubdir: 'adrs' },
    filenamePattern: '{label}-adr.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'review-board-packet',
    name: 'Review Board Packet',
    description: 'Assemble architecture docs into a decision packet for review boards.',
    category: 'architecture',
    skillKind: 'review-packet',
    inputSource: {
      kind: 'text-or-files',
      fileTypes: ['daily-log', 'weekly-report', 'wiki-source', 'canon-note', 'adr'],
      label: 'Architecture docs (generated notes/ADRs) and/or pasted material',
    },
    outputType: 'review-packet',
    destination: { fallbackSubdir: 'review-packets' },
    filenamePattern: '{label}-review-packet.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'sprint-planning',
    name: 'Sprint Planning Prep',
    description: 'Turn notes and backlog items into a planning brief.',
    category: 'planning',
    skillKind: 'planning-brief',
    inputSource: {
      kind: 'text-or-files',
      fileTypes: ['daily-log', 'weekly-report'],
      label: 'Notes + backlog items (pasted) and/or recent logs',
    },
    outputType: 'planning-brief',
    destination: { fallbackSubdir: 'planning' },
    filenamePattern: '{label}-planning-brief.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'one-on-one-prep',
    name: '1:1 Prep',
    description: 'Turn recent work and blockers into talking points for a 1:1.',
    category: 'planning',
    skillKind: 'talking-points',
    inputSource: {
      kind: 'text-or-files',
      fileTypes: ['daily-log', 'weekly-report'],
      label: 'Recent daily logs and/or pasted blockers & topics',
    },
    outputType: 'talking-points',
    destination: { fallbackSubdir: 'one-on-ones' },
    filenamePattern: '{label}-1on1-prep.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'decision-extractor',
    name: 'Decision Extractor',
    description: 'Pull every decision — made and needed — out of work logs and notes.',
    category: 'architecture',
    skillKind: 'decision-extract',
    inputSource: {
      kind: 'text-or-files',
      fileTypes: ['daily-log', 'weekly-report', 'wiki-source', 'canon-note'],
      label: 'Work logs and/or pasted notes to mine for decisions',
    },
    outputType: 'decision-list',
    destination: { fallbackSubdir: 'decisions' },
    filenamePattern: '{label}-decisions.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'risk-extractor',
    name: 'Risk Extractor',
    description: 'Surface risks, blockers, and ownership gaps from work logs and notes.',
    category: 'architecture',
    skillKind: 'risk-extract',
    inputSource: {
      kind: 'text-or-files',
      fileTypes: ['daily-log', 'weekly-report', 'wiki-source', 'canon-note'],
      label: 'Work logs and/or pasted notes to mine for risks',
    },
    outputType: 'risk-register',
    destination: { fallbackSubdir: 'risks' },
    filenamePattern: '{label}-risks.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'roadmap-to-backlog',
    name: 'Roadmap to Backlog',
    description: 'Break a roadmap or initiative into epics, features, and thin slices.',
    category: 'architecture',
    skillKind: 'backlog',
    inputSource: {
      kind: 'text-or-files',
      fileTypes: ['canon-note', 'adr', 'review-packet'],
      label: 'Roadmap / initiative notes (pasted) and/or architecture docs',
    },
    outputType: 'backlog',
    destination: { fallbackSubdir: 'backlogs' },
    filenamePattern: '{label}-backlog.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'microsoft-alignment',
    name: 'Microsoft Alignment Review',
    description: 'Review plans against the Microsoft AI stack: Foundry, Copilot, APIM, MCP, Entra.',
    category: 'architecture',
    skillKind: 'alignment-review',
    inputSource: {
      kind: 'text-or-files',
      fileTypes: ['daily-log', 'weekly-report', 'canon-note', 'adr', 'review-packet'],
      label: 'Architecture plans/notes to review for Microsoft-stack alignment',
    },
    outputType: 'alignment-review',
    destination: { fallbackSubdir: 'alignment-reviews' },
    filenamePattern: '{label}-alignment-review.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'talk-track',
    name: 'Talk Track Builder',
    description: 'Turn work notes into short, ready-to-say meeting language.',
    category: 'architecture',
    skillKind: 'talk-track',
    inputSource: {
      kind: 'text-or-files',
      fileTypes: ['daily-log', 'weekly-report', 'decision-list', 'risk-register'],
      label: 'Notes and/or recent logs to turn into meeting language',
    },
    outputType: 'talk-track',
    destination: { fallbackSubdir: 'talk-tracks' },
    filenamePattern: '{label}-talk-track.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
  {
    id: 'fable-output-qa',
    name: 'Fable Output QA',
    description: 'Critique AI-generated docs and produce an improvement plan.',
    category: 'quality',
    skillKind: 'qa-critique',
    inputSource: {
      kind: 'text-or-files',
      fileTypes: ['daily-log', 'weekly-report', 'wiki-source', 'canon-note', 'adr', 'review-packet'],
      label: 'AI-generated docs to review (pasted or selected)',
    },
    outputType: 'qa-critique',
    destination: { fallbackSubdir: 'qa-critiques' },
    filenamePattern: '{label}-qa-critique.md',
    dateMode: 'date',
    approvalRule: 'none',
    builtIn: true,
  },
];

export function getWorkflow(id: string): WorkflowDef | null {
  return WORKFLOWS.find((w) => w.id === id) ?? null;
}

/** Workflow defs whose output type matches, e.g. to find where artifacts of a type live. */
export function workflowsByOutputType(type: string): WorkflowDef[] {
  return WORKFLOWS.filter((w) => w.outputType === type);
}

/** All output types any workflow can produce (used by artifact filters/listers). */
export function allOutputTypes(): string[] {
  return [...new Set(WORKFLOWS.map((w) => w.outputType))];
}

/** All the workflows allowed for a config (hook for future per-profile allow-lists). */
export function allowedWorkflows(_cfg: Config): WorkflowDef[] {
  return WORKFLOWS;
}

// --- Modes ---------------------------------------------------------------------
// A mode is a curated, purpose-named bundle of workflows — a lens over the same
// engine. The first one is the AI Architecture Workbench used for architecture
// leadership work; future modes (profiles) can add their own bundles.

export type WorkbenchMode = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  workflowIds: string[];
};

export const ARCHITECTURE_MODE: WorkbenchMode = {
  id: 'architecture',
  name: 'AI Architecture Workbench',
  tagline: 'Your architecture artifact factory.',
  description:
    'Everything an AI architect produces on a working week: structured logs, ' +
    'director-ready reports, decision and risk registers, ADRs, review board packets, ' +
    'backlog breakdowns, Microsoft-stack alignment reviews, and meeting talk tracks.',
  workflowIds: [
    'daily-log',
    'weekly-report',
    'decision-extractor',
    'risk-extractor',
    'adr',
    'review-board-packet',
    'roadmap-to-backlog',
    'microsoft-alignment',
    'talk-track',
    'architecture-canon',
  ],
};

export const MODES: WorkbenchMode[] = [ARCHITECTURE_MODE];

export function getMode(id: string): WorkbenchMode | null {
  return MODES.find((m) => m.id === id) ?? null;
}

export function modeWorkflows(mode: WorkbenchMode): WorkflowDef[] {
  return mode.workflowIds.map((id) => getWorkflow(id)).filter((w): w is WorkflowDef => !!w);
}
