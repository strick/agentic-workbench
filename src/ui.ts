// Server-rendered HTML UI. No frontend framework: template literals + small
// inline scripts that call the JSON API.
import path from 'node:path';
import { APP_ROOT, type LoadedConfig } from './config.ts';
import type { PathCheck } from './paths.ts';
import type { Skill } from './skills.ts';
import type { ProviderHealth } from './providers/index.ts';
import type { ArtifactRecord, GoldenExample, RunRecord, SkillPref, SkillVersionRow } from './store.ts';
import type { SourceFile } from './workflows.ts';
import { allOutputTypes, type WorkbenchMode, type WorkflowDef } from './workflowDefs.ts';

export function esc(s: unknown): string {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const CSS = `
:root{--bg:#10141a;--panel:#171d26;--panel2:#1e2633;--line:#2a3547;--text:#dbe4f0;--dim:#8899ad;
--accent:#5eadf2;--ok:#4cc38a;--warn:#e5b567;--err:#e5726f;--mono:ui-monospace,Consolas,monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:15px/1.5 system-ui,'Segoe UI',sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;align-items:center;gap:18px;padding:10px 22px;background:var(--panel);
border-bottom:1px solid var(--line);flex-wrap:wrap}
header .logo{font-weight:700;letter-spacing:.4px}
header nav{display:flex;gap:4px;flex-wrap:wrap}
header nav a{padding:5px 11px;border-radius:7px;color:var(--dim)}
header nav a.active,header nav a:hover{background:var(--panel2);color:var(--text);text-decoration:none}
main{max-width:1060px;margin:0 auto;padding:22px}
h1{font-size:21px;margin:.2em 0 .7em}h2{font-size:16px;margin:1.4em 0 .5em;color:var(--dim);
text-transform:uppercase;letter-spacing:.6px;font-weight:600}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:14px}
th{color:var(--dim);text-align:left;font-weight:600;padding:6px 10px;border-bottom:1px solid var(--line)}
td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
.badge{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600}
.b-ok{background:#173527;color:var(--ok)}.b-warn{background:#3a2f16;color:var(--warn)}
.b-err{background:#3a1d1c;color:var(--err)}.b-dim{background:var(--panel2);color:var(--dim)}
.b-info{background:#16293a;color:var(--accent)}
code,.mono{font-family:var(--mono);font-size:13px}
pre{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:12px;
overflow:auto;font-size:13px;white-space:pre-wrap}
input[type=text],input[type=date],select,textarea{width:100%;background:var(--panel2);color:var(--text);
border:1px solid var(--line);border-radius:7px;padding:8px 10px;font:inherit}
textarea{font-family:var(--mono);font-size:13px;min-height:180px}
label{display:block;margin:12px 0 4px;color:var(--dim);font-size:13px;font-weight:600}
button{background:var(--accent);color:#0b1520;border:none;border-radius:7px;padding:8px 16px;
font:inherit;font-weight:600;cursor:pointer}
button.secondary{background:var(--panel2);color:var(--text);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:14px;flex-wrap:wrap}.row>*{flex:1;min-width:260px}
.actions{display:flex;gap:10px;margin:14px 0;flex-wrap:wrap}
.msg{margin:12px 0;padding:10px 14px;border-radius:8px;display:none}
.msg.ok{display:block;background:#173527;color:var(--ok)}
.msg.err{display:block;background:#3a1d1c;color:var(--err)}
.dim{color:var(--dim)}.small{font-size:13px}
.qa{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
.qa a{display:block;background:var(--panel2);border:1px solid var(--line);border-radius:10px;
padding:14px;color:var(--text);font-weight:600}
.qa a:hover{border-color:var(--accent);text-decoration:none}
.qa a span{display:block;font-weight:400;color:var(--dim);font-size:13px;margin-top:4px}
details summary{cursor:pointer;color:var(--accent)}
`;

const NAV = [
  ['/', 'Dashboard'],
  ['/settings', 'Settings'],
  ['/skills', 'Skills'],
  ['/lab', 'Skill Lab'],
  ['/shootout', 'Shootout'],
  ['/workflows', 'Workflows'],
  ['/architecture', 'Architecture'],
  ['/runs', 'Runs'],
  ['/artifacts', 'Artifacts'],
] as const;

export function layout(title: string, active: string, content: string): string {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === active ? ' class="active"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Agentic Workbench</title><style>${CSS}</style></head>
<body><header><div class="logo">🛠 Agentic Workbench</div><nav>${nav}</nav></header>
<main>${content}</main>
<script>
async function api(url,opts){const r=await fetch(url,Object.assign({headers:{'Content-Type':'application/json'}},opts));
const j=await r.json().catch(()=>({error:'Bad response'}));if(!r.ok||j.error)throw new Error(j.error||r.statusText);return j}
function msg(id,text,ok){const el=document.getElementById(id);if(!el)return;el.textContent='';
el.className='msg '+(ok?'ok':'err');el.append(text||'');if(typeof arguments[3]==='object'&&arguments[3]){el.append(' ');el.append(arguments[3])}}
</script></body></html>`;
}

function statusBadge(status: string): string {
  const map: Record<string, string> = {
    writable: 'b-ok', 'read-only': 'b-warn', missing: 'b-err', unreadable: 'b-err',
    'not-configured': 'b-dim', completed: 'b-ok', running: 'b-info', error: 'b-err',
  };
  return `<span class="badge ${map[status] ?? 'b-dim'}">${esc(status)}</span>`;
}

function pathsTable(paths: PathCheck[]): string {
  const rows = paths
    .map(
      (p) => `<tr><td>${esc(p.label)}</td>
<td class="mono small">${esc(p.resolved || '—')}</td>
<td>${statusBadge(p.status)}</td>
<td class="dim small">${esc(p.note || '')}${p.fallback ? `<br>fallback: <span class="mono">${esc(p.fallback)}</span>` : ''}</td></tr>`,
    )
    .join('');
  return `<table><tr><th>Path</th><th>Resolved</th><th>Status</th><th>Notes</th></tr>${rows}</table>`;
}

function providerRows(health: Array<{ id: string; name: string; capabilities: string[] } & ProviderHealth>): string {
  return health
    .map(
      (h) => `<tr><td><b>${esc(h.name)}</b><br><span class="mono small dim">${esc(h.id)}</span></td>
<td>${h.healthy ? '<span class="badge b-ok">available</span>' : '<span class="badge b-warn">unavailable</span>'}</td>
<td class="small dim">${esc(h.detail)}</td></tr>`,
    )
    .join('');
}

function skillOptions(skills: Skill[], preferKind: string, selectedId?: string): string {
  const sorted = [...skills].sort((a, b) => Number(b.kind === preferKind) - Number(a.kind === preferKind));
  return sorted
    .map((s) => {
      const sel = selectedId ? s.id === selectedId : s === sorted[0];
      return `<option value="${esc(s.id)}"${sel ? ' selected' : ''}>${esc(s.name)} ${s.source === 'examples' ? '(example)' : ''} — ${esc(s.kind)}</option>`;
    })
    .join('');
}

function providerOptions(defaultProvider: string): string {
  return ['mock', 'claude-cli', 'copilot-cli']
    .map((p) => `<option value="${p}"${p === defaultProvider ? ' selected' : ''}>${p}</option>`)
    .join('');
}

// Per-run provider options: model override passed straight to the CLI (--model).
const MODEL_FIELD = `<div><label for="modelInp">Model <span class="dim">(optional, CLI providers only)</span></label>
<input type="text" id="modelInp" placeholder="e.g. claude-sonnet-5 — blank = provider default" spellcheck="false"></div>`;
const MODEL_JS = `function modelVal(){return document.getElementById('modelInp').value.trim()}`;

function runRows(runs: RunRecord[]): string {
  if (!runs.length) return '<tr><td colspan="9" class="dim">No runs yet.</td></tr>';
  return runs
    .map(
      (r) => `<tr><td><a href="/run?id=${esc(r.id)}" class="mono">${esc(r.id.slice(0, 8))}</a></td>
<td>${esc(r.artifact_type)}</td><td>${esc(r.skill_name)}</td><td class="mono small">${esc(r.provider_id)}</td>
<td class="mono small">${r.model_used ? esc(r.model_used) : '<span class="dim">—</span>'}</td>
<td>${statusBadge(r.status)}</td><td class="small dim">${esc(r.created_at.slice(0, 19).replace('T', ' '))}</td>
<td class="small">${r.cost_usd ? '$' + r.cost_usd.toFixed(4) : '<span class="dim">—</span>'}</td>
<td class="small">${r.credits_used ? r.credits_used.toFixed(2) : '<span class="dim">—</span>'}</td></tr>`,
    )
    .join('');
}

// --- Pages -------------------------------------------------------------------

export function pageDashboard(d: {
  needsSetup: boolean;
  paths: PathCheck[];
  providers: Array<{ id: string; name: string; capabilities: string[] } & ProviderHealth>;
  runs: RunRecord[];
  artifacts: ArtifactRecord[];
  skillCount: number;
  storeBackend: string;
}): string {
  const setupBanner = d.needsSetup
    ? `<div class="panel" style="border-color:var(--warn)"><b>⚙ First-run setup:</b> no real note folders are configured yet —
       everything currently falls back to the local <span class="mono">/data</span> folder (which works fine for trying it out).
       <a href="/settings">Open Settings</a> to point the workbench at your <span class="mono">.copilot/skills</span> folder and Obsidian vault.</div>`
    : '';
  const artifacts = d.artifacts.length
    ? d.artifacts
        .map(
          (a) => `<tr><td>${esc(a.title)}</td><td>${esc(a.type)}</td>
<td class="small dim mono">${esc(a.path)}</td><td><a href="/artifacts?preview=${encodeURIComponent(a.path)}">preview</a></td></tr>`,
        )
        .join('')
    : '<tr><td colspan="4" class="dim">No artifacts yet.</td></tr>';
  return layout('Dashboard', '/', `
<h1>Dashboard</h1>
${setupBanner}
<h2>Quick actions</h2>
<div class="qa">
  <a href="/workflow?id=daily-log">📝 New Daily Log<span>Paste dictated notes, run a skill</span></a>
  <a href="/workflow?id=weekly-report">📊 Generate Weekly Report<span>Synthesize a week of daily logs</span></a>
  <a href="/workflow?id=wiki-source">📚 Generate Wiki Source<span>Sanitized canon source notes</span></a>
  <a href="/workflows">🧰 All Workflows<span>ADRs, review packets, 1:1 prep, and more</span></a>
</div>
<h2>Configured paths</h2>
<div class="panel">${pathsTable(d.paths)}
<p class="small dim">Skills loaded: <b>${d.skillCount}</b> · Metadata store: <b>${esc(d.storeBackend)}</b></p></div>
<h2>Providers</h2>
<div class="panel"><table><tr><th>Provider</th><th>Health</th><th>Detail</th></tr>${providerRows(d.providers)}</table></div>
<h2>Recent runs</h2>
<div class="panel"><table><tr><th>Run</th><th>Type</th><th>Skill</th><th>Provider</th><th>Model</th><th>Status</th><th>Created</th><th>Cost</th><th>Credits</th></tr>
${runRows(d.runs)}</table></div>
<h2>Latest artifacts</h2>
<div class="panel"><table><tr><th>File</th><th>Type</th><th>Path</th><th></th></tr>${artifacts}</table></div>`);
}

export function pageSettings(d: {
  cfg: LoadedConfig;
  paths: PathCheck[];
  providers: Array<{ id: string; name: string; capabilities: string[] } & ProviderHealth>;
}): string {
  const c = d.cfg;
  const field = (key: string, label: string, value: string, placeholder: string) => `
<label for="${key}">${esc(label)} <span class="dim">(source: ${esc(c.sources[key] ?? 'default')})</span></label>
<input type="text" id="${key}" name="${key}" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false">`;
  return layout('Settings', '/settings', `
<h1>Settings / First-Run Setup</h1>
<p class="dim">Values are saved to <span class="mono">local-config.json</span> (gitignored — machine-specific paths never
enter the repo). Environment overrides can also be set in <span class="mono">.env.local</span>; the settings saved here take precedence.</p>
<div class="panel">
${field('skillsDir', 'Skills directory', c.skillsDir, 'e.g. C:\\Users\\you\\.copilot\\skills (blank = auto-detect)')}
${field('obsidianVaultDir', 'Obsidian vault root', c.obsidianVaultDir, 'e.g. C:\\Users\\you\\Documents\\Obsidian Notes\\Personal\\Work')}
${field('dailyLogDir', 'Daily log output folder', c.dailyLogDir, 'blank = ./data/daily-logs')}
${field('weeklyReportDir', 'Weekly report output folder', c.weeklyReportDir, 'blank = ./data/weekly-reports')}
${field('wikiSourceDir', 'Wiki source output folder', c.wikiSourceDir, 'blank = ./data/wiki-source')}
${field('dataDir', 'Local app data folder', c.dataDir, './data')}
<label for="defaultProvider">Default provider</label>
<select id="defaultProvider" name="defaultProvider">${providerOptions(c.defaultProvider)}</select>
${field('claudeCliPath', 'Claude CLI path or command', c.claudeCliPath, 'e.g. claude or C:\\...\\claude.exe')}
${field('copilotCliPath', 'GitHub Copilot CLI path or command', c.copilotCliPath, 'e.g. copilot or gh')}
<div class="actions">
  <button id="saveBtn">Save local config</button>
  <button id="validateBtn" class="secondary">Validate paths</button>
</div>
<div id="settingsMsg" class="msg"></div>
</div>
<h2>Path validation</h2>
<div class="panel" id="pathsPanel">${pathsTable(d.paths)}</div>
<h2>Provider health</h2>
<div class="panel"><table><tr><th>Provider</th><th>Health</th><th>Detail</th></tr>${providerRows(d.providers)}</table></div>
<script>
const KEYS=['skillsDir','obsidianVaultDir','dailyLogDir','weeklyReportDir','wikiSourceDir','dataDir','defaultProvider','claudeCliPath','copilotCliPath'];
function collect(){const o={};for(const k of KEYS){o[k]=document.getElementById(k).value.trim()}return o}
document.getElementById('saveBtn').onclick=async()=>{try{
await api('/api/config',{method:'POST',body:JSON.stringify(collect())});
msg('settingsMsg','Saved. Reloading to reflect new paths…',true);setTimeout(()=>location.reload(),700);
}catch(e){msg('settingsMsg','Save failed: '+e.message,false)}};
document.getElementById('validateBtn').onclick=async()=>{try{
const r=await api('/api/paths/validate?'+new URLSearchParams(collect()));
document.getElementById('pathsPanel').innerHTML=r.html;
msg('settingsMsg','Validated current field values (not yet saved).',true);
}catch(e){msg('settingsMsg','Validation failed: '+e.message,false)}};
</script>`);
}

export function pageSkills(d: { skills: Skill[]; skillsDir: string; skillsDirSource: string; versionCounts: Record<string, number> }): string {
  const rows = d.skills
    .map(
      (s) => `<tr>
<td><b>${esc(s.name)}</b><br><span class="dim small">${esc(s.description).slice(0, 140)}</span></td>
<td>${s.source === 'configured' ? '<span class="badge b-info">configured</span>' : '<span class="badge b-dim">example</span>'}<br><span class="badge b-dim">${esc(s.kind)}</span></td>
<td class="mono small">${esc(s.relPath)}<br><span class="dim">hash ${esc(s.shortHash)} · v${d.versionCounts[s.id] ?? 1}</span></td>
<td>
  <div class="actions" style="margin:0">
    <button class="secondary" onclick="preview('${esc(s.id)}')">Preview</button>
    <a href="/lab/skill?id=${esc(s.id)}"><button class="secondary">Lab</button></a>
    <a href="/inbox?skill=${esc(s.id)}"><button>Run</button></a>
  </div>
</td></tr>
<tr id="prev-${esc(s.id)}" style="display:none"><td colspan="4"><pre id="prevbody-${esc(s.id)}"></pre>
<div class="small dim">Parsed metadata: <span class="mono">${esc(JSON.stringify(s.meta))}</span></div></td></tr>`,
    )
    .join('');
  return layout('Skills', '/skills', `
<h1>Skills</h1>
<p class="dim">Skills directory: <span class="mono">${esc(d.skillsDir || '(none)')}</span> — ${esc(d.skillsDirSource)}.
Bundled examples from <span class="mono">/examples/skills</span> are always available.</p>
<div class="panel"><table><tr><th>Skill</th><th>Source / kind</th><th>File</th><th>Actions</th></tr>${rows ||
    '<tr><td colspan="4" class="dim">No skills found.</td></tr>'}</table></div>
<script>
async function preview(id){const row=document.getElementById('prev-'+id);
if(row.style.display!=='none'){row.style.display='none';return}
try{const r=await api('/api/skills/raw?id='+id);document.getElementById('prevbody-'+id).textContent=r.raw;
row.style.display='';}catch(e){alert(e.message)}}
</script>`);
}

const CATEGORY_LABELS: Record<WorkflowDef['category'], string> = {
  core: 'Core work routine',
  architecture: 'Architecture',
  planning: 'Planning & people',
  quality: 'Quality',
};

export function pageWorkflows(d: { workflows: WorkflowDef[] }): string {
  const categories = [...new Set(d.workflows.map((w) => w.category))];
  const sections = categories
    .map((cat) => {
      const rows = d.workflows
        .filter((w) => w.category === cat)
        .map(
          (w) => `<tr>
<td><b>${esc(w.name)}</b><br><span class="dim small">${esc(w.description)}</span></td>
<td class="small dim">${esc(w.inputSource.label)}</td>
<td><span class="badge b-dim">${esc(w.outputType)}</span></td>
<td><a href="/workflow?id=${esc(w.id)}"><button>Open</button></a></td></tr>`,
        )
        .join('');
      return `<h2>${esc(CATEGORY_LABELS[cat])}</h2>
<div class="panel"><table><tr><th>Workflow</th><th>Input</th><th>Output type</th><th></th></tr>${rows}</table></div>`;
    })
    .join('');
  return layout('Workflows', '/workflows', `
<h1>Workflows</h1>
<p class="dim">Every workflow is <b>Skill + Input Source + Provider + Output Type + Destination + Approval Rule</b>.
The original daily log, weekly report, and wiki source flows are built-in templates of the same model.</p>
${sections}`);
}

export function pageWorkflowRun(d: {
  def: WorkflowDef;
  skills: Skill[];
  defaultProvider: string;
  files: SourceFile[];
  inboxNotes: Array<{ name: string; path: string }>;
  preselectSkill?: string;
}): string {
  const w = d.def;
  const acceptsText = w.inputSource.kind === 'text' || w.inputSource.kind === 'text-or-files';
  const acceptsFiles = w.inputSource.kind === 'files' || w.inputSource.kind === 'text-or-files';

  const textBlock = acceptsText
    ? `<label for="noteText">Input notes <span class="dim">(${esc(w.inputSource.label)})</span></label>
<textarea id="noteText" placeholder="Paste your input here…"></textarea>`
    : '';

  const fileRows = d.files.length
    ? d.files
        .map(
          (f) => `<tr><td><input type="checkbox" class="srcSel" value="${esc(f.path)}" data-week="${esc(f.week)}"></td>
<td class="mono small">${esc(f.name)}</td><td class="dim small">${esc(f.type)}</td><td class="mono small dim">${esc(f.week || '')}</td><td class="mono small dim">${esc(f.path)}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="dim">No source files found yet — generate some artifacts first.</td></tr>';
  const filesBlock = acceptsFiles
    ? `<h2>Source files</h2>
<table><tr><th></th><th>File</th><th>Type</th><th>Week</th><th>Path</th></tr>${fileRows}</table>`
    : '';

  const weeks = [...new Set(d.files.map((f) => f.week).filter(Boolean))].sort().reverse();
  const labelField =
    w.dateMode === 'week'
      ? `<div><label for="labelInp">Week (auto-selects matching files)</label>
<select id="labelInp">${weeks.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('') || '<option value="">(no dated files found)</option>'}</select></div>`
      : `<div><label for="labelInp">Date</label><input type="date" id="labelInp"></div>`;

  const inboxBlock =
    acceptsText && d.inboxNotes.length
      ? `<h2>Saved inbox notes</h2>
<div class="panel"><table>${d.inboxNotes
          .map(
            (n) => `<tr><td class="mono small">${esc(n.name)}</td>
<td><button class="secondary" onclick="loadNote('${esc(n.name)}')">Load into editor</button></td></tr>`,
          )
          .join('')}</table></div>`
      : '';

  const saveNoteBtn = acceptsText ? `<button id="saveNoteBtn" class="secondary">Save note to inbox</button>` : '';

  return layout(w.name, '/workflows', `
<h1>${esc(w.name)}</h1>
<p class="dim">${esc(w.description)} Output type <span class="badge b-dim">${esc(w.outputType)}</span> · approval rule: <span class="mono">${esc(w.approvalRule)}</span>.</p>
<div class="panel">
${textBlock}
<div class="row">
  ${labelField}
  <div><label for="skillSel">Skill</label><select id="skillSel">${skillOptions(d.skills, w.skillKind, d.preselectSkill)}</select></div>
  <div><label for="provSel">Provider</label><select id="provSel">${providerOptions(d.defaultProvider)}</select></div>
  ${MODEL_FIELD}
</div>
${filesBlock}
<div class="actions">
  <button id="runBtn">Run ${esc(w.name)}</button>
  ${saveNoteBtn}
</div>
<div id="wfMsg" class="msg"></div>
<label>Live model output <span class="dim">(raw provider stream, updates as the run executes)</span></label>
<pre id="livePane" style="display:none;max-height:280px;overflow:auto"></pre>
<pre id="outputPreview" style="display:none"></pre>
</div>
${inboxBlock}
<script>
${MODEL_JS}
const WEEK_MODE=${w.dateMode === 'week' ? 'true' : 'false'};
if(!WEEK_MODE)document.getElementById('labelInp').value=new Date().toISOString().slice(0,10);
if(WEEK_MODE){const sel=document.getElementById('labelInp');
const selectWeek=()=>{document.querySelectorAll('.srcSel').forEach(c=>{c.checked=c.dataset.week===sel.value})};
sel.onchange=selectWeek;selectWeek();}
async function loadNote(name){try{const r=await api('/api/inbox/read?name='+encodeURIComponent(name));
document.getElementById('noteText').value=r.text;msg('wfMsg','Loaded '+name,true)}catch(e){msg('wfMsg',e.message,false)}}
const saveBtn=document.getElementById('saveNoteBtn');
if(saveBtn)saveBtn.onclick=async()=>{try{
const t=document.getElementById('noteText').value;if(!t.trim())throw new Error('Nothing to save.');
const r=await api('/api/inbox',{method:'POST',body:JSON.stringify({text:t})});
msg('wfMsg','Saved to '+r.name+' — reload page to see it listed.',true)}catch(e){msg('wfMsg',e.message,false)}};
document.getElementById('runBtn').onclick=async()=>{
const b=document.getElementById('runBtn');b.disabled=true;
const live=document.getElementById('livePane');live.textContent='';live.style.display='';
document.getElementById('outputPreview').style.display='none';
msg('wfMsg','Running…',true);
try{
const noteEl=document.getElementById('noteText');
const body={workflowId:'${esc(w.id)}',
noteText:noteEl?noteEl.value:'',
files:[...document.querySelectorAll('.srcSel:checked')].map(c=>c.value),
label:document.getElementById('labelInp').value,
skillId:document.getElementById('skillSel').value,providerId:document.getElementById('provSel').value,model:modelVal()};
const r=await api('/api/run/workflow',{method:'POST',body:JSON.stringify(body)});
const es=new EventSource('/api/runs/'+r.runId+'/stream');
es.onmessage=(ev)=>{try{live.textContent+=JSON.parse(ev.data)+'\\n';live.scrollTop=live.scrollHeight}catch{}};
es.addEventListener('done',async(ev)=>{
es.close();
let result={};try{result=JSON.parse(ev.data)}catch{}
if(result.status==='completed'){
const link=document.createElement('a');link.href='/run?id='+result.runId;link.textContent='view run '+result.runId.slice(0,8);
msg('wfMsg','Artifact written to '+result.artifactPath+(result.usedFallbackDir?' (local fallback folder)':'')+' — ',true,link);
try{const pv=await api('/api/artifacts/content?path='+encodeURIComponent(result.artifactPath));
const pre=document.getElementById('outputPreview');pre.textContent=pv.content;pre.style.display=''}catch(e){}
}else{
msg('wfMsg',result.error||'Run failed.',false);
}
b.disabled=false;
});
}catch(e){msg('wfMsg',e.message,false);b.disabled=false}};
</script>`);
}

// --- Skill Lab ---------------------------------------------------------------

const PROVIDER_IDS = ['mock', 'claude-cli', 'copilot-cli'] as const;

export function pageLab(d: {
  skills: Skill[];
  versionCounts: Record<string, number>;
  prefs: Record<string, SkillPref>;
  goldenCounts: Record<string, number>;
}): string {
  const rows = d.skills
    .map((s) => {
      const pref = d.prefs[s.id];
      const provSel = PROVIDER_IDS.map(
        (p) => `<option value="${p}"${pref?.provider_id === p ? ' selected' : ''}>${p}</option>`,
      ).join('');
      return `<tr>
<td><b><a href="/lab/skill?id=${esc(s.id)}">${esc(s.name)}</a></b><br>
<span class="dim small">${esc(s.description).slice(0, 110)}</span></td>
<td><span class="badge b-dim">${esc(s.kind)}</span><br><span class="dim small">${esc(s.source)}</span></td>
<td class="mono small">${esc(s.shortHash)}<br><span class="dim">v${d.versionCounts[s.id] ?? 1}</span></td>
<td class="small">${d.goldenCounts[s.id] ?? 0}</td>
<td>
  <select id="prov-${esc(s.id)}" style="width:auto">${provSel}</select>
  <input type="text" id="model-${esc(s.id)}" value="${esc(pref?.model ?? '')}" placeholder="model (optional)" style="width:150px" spellcheck="false">
  <button class="secondary" onclick="savePref('${esc(s.id)}')">Save</button>
</td>
<td><a href="/lab/skill?id=${esc(s.id)}"><button>Open</button></a></td></tr>`;
    })
    .join('');
  return layout('Skill Lab', '/lab', `
<h1>Skill Lab</h1>
<p class="dim">Your prompt/skill governance lab: version history, sandboxed test runs, provider comparison,
golden examples, and output scoring. Lab runs write only to <span class="mono">data/lab-outputs</span> — never
into your real note folders.</p>
<div id="labMsg" class="msg"></div>
<div class="panel"><table>
<tr><th>Skill</th><th>Kind / source</th><th>Hash / versions</th><th>Golden</th><th>Preferred provider / model</th><th></th></tr>
${rows || '<tr><td colspan="6" class="dim">No skills found.</td></tr>'}</table></div>
<script>
async function savePref(id){try{
await api('/api/lab/prefs',{method:'POST',body:JSON.stringify({skillId:id,
providerId:document.getElementById('prov-'+id).value,model:document.getElementById('model-'+id).value.trim()})});
msg('labMsg','Preference saved.',true)}catch(e){msg('labMsg',e.message,false)}}
</script>`);
}

export function pageLabSkill(d: {
  skill: Skill;
  versions: SkillVersionRow[];
  pref: SkillPref | null;
  golden: GoldenExample[];
  labRuns: RunRecord[];
  scores: Record<string, string>;
}): string {
  const s = d.skill;
  const provChecks = PROVIDER_IDS.map((p) => {
    const checked = d.pref ? d.pref.provider_id === p : p === 'mock';
    return `<label style="display:inline-block;margin-right:16px;font-weight:400">
<input type="checkbox" class="provChk" value="${p}"${checked ? ' checked' : ''}> ${p}</label>`;
  }).join('');
  const versionRows = d.versions
    .map((v, i) => `<tr><td class="mono small">${esc(v.hash.slice(0, 16))}${i === 0 ? ' <span class="badge b-info">current</span>' : ''}</td>
<td class="small dim">${esc(v.seen_at.slice(0, 19).replace('T', ' '))}</td></tr>`)
    .join('');
  const goldenRows = d.golden.length
    ? d.golden
        .map(
          (g) => `<tr><td class="small dim">${esc(g.created_at.slice(0, 19).replace('T', ' '))}</td>
<td class="mono small">${esc(g.skill_hash.slice(0, 12))}</td>
<td class="small">${esc(g.note || '—')}</td>
<td><details><summary>input / output</summary>
<pre style="max-height:200px;overflow:auto">${esc(g.input_text)}</pre>
<pre style="max-height:300px;overflow:auto">${esc(g.output_text)}</pre></details></td>
<td><button class="secondary" onclick="delGolden('${esc(g.id)}')">Delete</button></td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="dim">No golden examples yet — run a test and save a good output.</td></tr>';
  const scoreBadge = (sc: string) =>
    sc ? `<span class="badge ${sc === 'good' ? 'b-ok' : sc === 'okay' ? 'b-warn' : 'b-err'}">${esc(sc)}</span>` : '<span class="dim">—</span>';
  const runRows2 = d.labRuns.length
    ? d.labRuns
        .map(
          (r) => `<tr><td><a href="/run?id=${esc(r.id)}" class="mono">${esc(r.id.slice(0, 8))}</a></td>
<td class="mono small">${esc(r.provider_id)}</td><td>${esc(r.status)}</td>
<td>${scoreBadge(d.scores[r.id] ?? '')}</td>
<td class="small dim">${esc(r.created_at.slice(0, 19).replace('T', ' '))}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="dim">No lab runs yet.</td></tr>';

  return layout(`Lab — ${s.name}`, '/lab', `
<h1>Skill Lab — ${esc(s.name)}</h1>
<p class="dim mono small">${esc(s.path)} · hash ${esc(s.shortHash)} · kind ${esc(s.kind)}</p>
<div class="panel">
<label for="sampleInput">Sample input</label>
<textarea id="sampleInput" placeholder="Paste sample input to test this skill against…"></textarea>
<label>Providers <span class="dim">(pick several to compare outputs side by side)</span></label>
<div>${provChecks}</div>
<div class="row">${MODEL_FIELD}</div>
<div class="actions"><button id="runBtn">Run test</button></div>
<div id="labMsg" class="msg"></div>
<label>Live output</label>
<pre id="livePane" style="display:none;max-height:240px;overflow:auto"></pre>
<div id="results"></div>
</div>
<h2>Version history</h2>
<div class="panel"><table><tr><th>Content hash</th><th>First seen</th></tr>${versionRows ||
    '<tr><td colspan="2" class="dim">No versions recorded yet.</td></tr>'}</table></div>
<h2>Golden examples</h2>
<div class="panel"><table><tr><th>Saved</th><th>Skill hash</th><th>Note</th><th>Content</th><th></th></tr>${goldenRows}</table></div>
<h2>Recent lab runs</h2>
<div class="panel"><table><tr><th>Run</th><th>Provider</th><th>Status</th><th>Score</th><th>Created</th></tr>${runRows2}</table></div>
<script>
${MODEL_JS}
const SKILL_ID='${esc(s.id)}';
function scoreBtns(runId){return ['good','okay','bad'].map(v=>
'<button class="secondary" onclick="scoreRun(\\''+runId+'\\',\\''+v+'\\',this)">'+v+'</button>').join(' ')}
async function scoreRun(runId,val,btn){try{
await api('/api/runs/score',{method:'POST',body:JSON.stringify({runId,score:val})});
btn.parentElement.querySelectorAll('button').forEach(b=>b.style.outline='');
btn.style.outline='2px solid var(--accent)';msg('labMsg','Scored '+val+'.',true)}catch(e){msg('labMsg',e.message,false)}}
async function saveGolden(runId,btn){try{
await api('/api/lab/golden',{method:'POST',body:JSON.stringify({skillId:SKILL_ID,runId})});
btn.disabled=true;btn.textContent='Saved ✓';msg('labMsg','Golden example saved.',true)}catch(e){msg('labMsg',e.message,false)}}
async function delGolden(id){try{
await api('/api/lab/golden/delete',{method:'POST',body:JSON.stringify({id})});
msg('labMsg','Deleted — reloading…',true);setTimeout(()=>location.reload(),500)}catch(e){msg('labMsg',e.message,false)}}
function resultCard(r,content){
return '<h2>'+r.provider_id+' — '+r.status+(r.durationMs!=null?' ('+(r.durationMs/1000).toFixed(1)+'s)':'')+'</h2>'+
'<div class="panel">'+(r.status==='completed'
?'<div class="actions" style="margin-top:0">'+scoreBtns(r.id)+' <button class="secondary" onclick="saveGolden(\\''+r.id+'\\',this)">Save as golden</button>'+
' <a href="/run?id='+r.id+'">view run</a></div><pre style="max-height:340px;overflow:auto">'+content.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</pre>'
:'<p class="dim">'+(r.error||r.status)+'</p>')+'</div>'}
async function renderResults(runs){
let html='';
for(const r of runs){
let content='';
if(r.status==='completed'&&r.output_artifact_path){
try{const pv=await api('/api/artifacts/content?path='+encodeURIComponent(r.output_artifact_path));content=pv.content}catch(e){content='(unreadable)'}}
html+=resultCard(r,content)}
document.getElementById('results').innerHTML=html}
document.getElementById('runBtn').onclick=async()=>{
const b=document.getElementById('runBtn');b.disabled=true;
document.getElementById('results').innerHTML='';
const provs=[...document.querySelectorAll('.provChk:checked')].map(c=>c.value);
const live=document.getElementById('livePane');live.textContent='';live.style.display=provs.length===1?'':'none';
msg('labMsg','Running against '+provs.join(', ')+'…',true);
try{
const body={skillId:SKILL_ID,providerIds:provs,inputText:document.getElementById('sampleInput').value,model:modelVal()};
const r=await api('/api/lab/run',{method:'POST',body:JSON.stringify(body)});
if(provs.length===1){
const runId=r.runs[0].runId;
const es=new EventSource('/api/runs/'+runId+'/stream');
es.onmessage=(ev)=>{try{live.textContent+=JSON.parse(ev.data)+'\\n';live.scrollTop=live.scrollHeight}catch{}};
es.addEventListener('done',async()=>{es.close();
const rr=(await api('/api/runs')).runs.find(x=>x.id===runId);
if(rr)await renderResults([{...rr,durationMs:rr.completed_at?new Date(rr.completed_at)-new Date(rr.created_at):null}]);
msg('labMsg','Run finished.',rr&&rr.status==='completed');b.disabled=false});
}else{
const poll=setInterval(async()=>{
const cr=await api('/api/lab/comparison?id='+r.comparisonId);
if(cr.runs.length&&cr.runs.every(x=>x.status!=='running')){
clearInterval(poll);await renderResults(cr.runs);
msg('labMsg','Comparison finished.',true);b.disabled=false}
},1500);
}
}catch(e){msg('labMsg',e.message,false);b.disabled=false}};
</script>`);
}

// --- Architecture Mode -----------------------------------------------------------

export function pageMode(d: { mode: WorkbenchMode; workflows: WorkflowDef[]; skillCounts: Record<string, number> }): string {
  const m = d.mode;
  const rows = d.workflows
    .map(
      (w) => `<tr>
<td><b>${esc(w.name)}</b><br><span class="dim small">${esc(w.description)}</span></td>
<td class="small dim">${esc(w.inputSource.label)}</td>
<td><span class="badge b-dim">${esc(w.outputType)}</span></td>
<td class="small">${d.skillCounts[w.skillKind] ?? 0} skill(s)</td>
<td><a href="/workflow?id=${esc(w.id)}"><button>Open</button></a></td></tr>`,
    )
    .join('');
  return layout(m.name, '/architecture', `
<h1>${esc(m.name)}</h1>
<p class="dim"><b>${esc(m.tagline)}</b> ${esc(m.description)}</p>
<div class="panel"><table>
<tr><th>Workflow</th><th>Input</th><th>Output</th><th>Matching skills</th><th></th></tr>
${rows}</table></div>
<p class="dim small">Each workflow prefers skills of its kind (frontmatter <span class="mono">kind:</span> or filename
match) but can run any skill. Test new skill wording in the <a href="/lab">Skill Lab</a> and compare providers in a
<a href="/shootout">Shootout</a> before trusting a workflow with real notes.</p>`);
}

// --- Provider Shootout ---------------------------------------------------------

export function pageShootout(d: {
  skills: Skill[];
  providers: Array<{ id: string; name: string; capabilities: string[] } & ProviderHealth>;
  defaultProvider: string;
  history: Array<{ comparison_id: string; created_at: string; skill_name: string; input_source: string; providers: string[]; statuses: string[] }>;
}): string {
  const provChecks = d.providers
    .map(
      (p) => `<label style="display:inline-block;margin-right:18px;font-weight:400">
<input type="checkbox" class="provChk" value="${esc(p.id)}"${p.id === 'mock' || p.healthy ? ' checked' : ''}> ${esc(p.id)}
${p.healthy ? '<span class="badge b-ok">available</span>' : '<span class="badge b-warn">unavailable</span>'}</label>`,
    )
    .join('');
  const historyRows = d.history.length
    ? d.history
        .map(
          (h) => `<tr><td class="small dim">${esc(h.created_at.slice(0, 19).replace('T', ' '))}</td>
<td>${esc(h.skill_name)}</td><td class="mono small">${h.providers.map(esc).join(', ')}</td>
<td class="small">${h.statuses.map((s) => statusBadge(s)).join(' ')}</td>
<td><a href="/shootout?cid=${esc(h.comparison_id)}">view</a></td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="dim">No shootouts yet.</td></tr>';

  return layout('Shootout', '/shootout', `
<h1>Provider Shootout</h1>
<p class="dim">Run the <b>same input through the same skill</b> on multiple providers and compare time, output,
and cost — so you know which model is worth spending on for which task. Artifacts land in
<span class="mono">data/shootouts</span>.</p>
<div class="panel">
<label for="inputText">Input note</label>
<textarea id="inputText" placeholder="Paste the input to run through every provider…"></textarea>
<div class="row">
  <div><label for="skillSel">Skill</label><select id="skillSel">${skillOptions(d.skills, 'daily-log')}</select></div>
  ${MODEL_FIELD}
</div>
<label>Providers</label>
<div>${provChecks}</div>
<div class="actions"><button id="runBtn">Run Shootout</button></div>
<div id="soMsg" class="msg"></div>
</div>
<div id="resultsWrap" style="display:none">
<h2>Results</h2>
<div class="panel"><table id="resultsTable">
<tr><th>Provider</th><th>Time</th><th>Status</th><th>Output length</th><th>Cost</th><th>Score</th><th>Artifact</th></tr>
</table></div>
<div id="outputs"></div>
</div>
<h2>Past shootouts</h2>
<div class="panel"><table><tr><th>When</th><th>Skill</th><th>Providers</th><th>Statuses</th><th></th></tr>${historyRows}</table></div>
<script>
${MODEL_JS}
function escHtml(t){return (t||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}
async function scoreRun(runId,val,btn){try{
await api('/api/runs/score',{method:'POST',body:JSON.stringify({runId,score:val})});
btn.parentElement.querySelectorAll('button').forEach(b=>b.style.outline='');
btn.style.outline='2px solid var(--accent)';msg('soMsg','Scored '+val+'.',true)}catch(e){msg('soMsg',e.message,false)}}
async function renderComparison(cid){
const cr=await api('/api/lab/comparison?id='+cid);
if(!cr.runs.length){msg('soMsg','Comparison not found.',false);return false}
const done=cr.runs.every(r=>r.status!=='running');
const tbl=document.getElementById('resultsTable');
tbl.innerHTML='<tr><th>Provider</th><th>Time</th><th>Status</th><th>Output length</th><th>Cost</th><th>Score</th><th>Artifact</th></tr>'+
cr.runs.map(r=>'<tr><td class="mono">'+r.provider_id+(r.model_used?' <span class="dim small">('+r.model_used+')</span>':'')+'</td>'+
'<td>'+(r.durationMs!=null?(r.durationMs/1000).toFixed(1)+'s':'…')+'</td>'+
'<td>'+r.status+'</td>'+
'<td>'+(r.outputLength!=null?r.outputLength+' B':'—')+'</td>'+
'<td>'+(r.cost_usd?'$'+r.cost_usd.toFixed(4):'—')+'</td>'+
'<td>'+(r.status==='completed'?['good','okay','bad'].map(v=>'<button class="secondary" onclick="scoreRun(\\''+r.id+'\\',\\''+v+'\\',this)"'+(r.score===v?' style="outline:2px solid var(--accent)"':'')+'>'+v+'</button>').join(' '):'—')+'</td>'+
'<td>'+(r.output_artifact_path?'<a href="/run?id='+r.id+'">view run</a>':(r.error?'<span class="small" style="color:var(--err)">'+escHtml(r.error.slice(0,60))+'</span>':'—'))+'</td></tr>').join('');
let out='';
for(const r of cr.runs){
if(r.status==='completed'&&r.output_artifact_path){
try{const pv=await api('/api/artifacts/content?path='+encodeURIComponent(r.output_artifact_path));
out+='<h2>'+r.provider_id+'</h2><div class="panel"><pre style="max-height:340px;overflow:auto">'+escHtml(pv.content)+'</pre></div>'}catch(e){}}}
document.getElementById('outputs').innerHTML=out;
document.getElementById('resultsWrap').style.display='';
return done}
document.getElementById('runBtn').onclick=async()=>{
const b=document.getElementById('runBtn');b.disabled=true;
try{
const provs=[...document.querySelectorAll('.provChk:checked')].map(c=>c.value);
const body={skillId:document.getElementById('skillSel').value,providerIds:provs,
inputText:document.getElementById('inputText').value,model:modelVal()};
const r=await api('/api/shootout',{method:'POST',body:JSON.stringify(body)});
msg('soMsg','Shootout running on '+provs.join(', ')+'…',true);
const poll=setInterval(async()=>{
try{if(await renderComparison(r.comparisonId)){clearInterval(poll);msg('soMsg','Shootout finished.',true);b.disabled=false}}
catch(e){clearInterval(poll);msg('soMsg',e.message,false);b.disabled=false}
},1500);
}catch(e){msg('soMsg',e.message,false);b.disabled=false}};
const cid=new URLSearchParams(location.search).get('cid');
if(cid)renderComparison(cid);
</script>`);
}

export function pageRuns(d: { runs: RunRecord[] }): string {
  return layout('Runs', '/runs', `
<h1>Runs</h1>
<div class="panel"><table><tr><th>Run</th><th>Type</th><th>Skill</th><th>Provider</th><th>Model</th><th>Status</th><th>Created</th><th>Cost</th><th>Credits</th></tr>
${runRows(d.runs)}</table></div>`);
}

export function pageRunDetail(d: { run: RunRecord | null; summary: string; artifactContent: string }): string {
  if (!d.run) return layout('Run', '/runs', '<h1>Run not found</h1><p><a href="/runs">Back to runs</a></p>');
  const r = d.run;
  const kv = (k: string, v: string, mono = true) =>
    `<tr><th style="width:220px">${esc(k)}</th><td class="${mono ? 'mono ' : ''}small">${v}</td></tr>`;
  return layout('Run ' + r.id.slice(0, 8), '/runs', `
<h1>Run <span class="mono">${esc(r.id.slice(0, 8))}</span> ${statusBadge(r.status)}</h1>
<div class="panel"><table>
${kv('Run id', esc(r.id))}
${kv('Summary', esc(d.summary), false)}
${kv('Artifact type', esc(r.artifact_type))}
${kv('Skill', `${esc(r.skill_name)} <span class="dim">(${esc(r.skill_id)})</span>`)}
${kv('Skill file path', esc(r.skill_path))}
${kv('Skill content hash', esc(r.skill_hash))}
${kv('Provider', esc(r.provider_id))}
${kv('Provider command', r.provider_command ? esc(r.provider_command) : '<span class="dim">n/a (in-process)</span>')}
${kv('Model used', r.model_used ? esc(r.model_used) : '<span class="dim">n/a</span>')}
${kv('Tokens (input)', r.tokens_input ? String(r.tokens_input) : '<span class="dim">n/a</span>')}
${kv('Tokens (output)', r.tokens_output ? String(r.tokens_output) : '<span class="dim">n/a</span>')}
${kv('Estimated cost', r.cost_usd ? `$${r.cost_usd.toFixed(4)}` : '<span class="dim">n/a</span>')}
${kv('Credits used', r.credits_used ? r.credits_used.toFixed(2) : '<span class="dim">n/a</span>')}
${kv('Input source', esc(r.input_source))}
${kv('Input files', r.input_files.length ? r.input_files.map(esc).join('<br>') : '<span class="dim">none</span>')}
${kv('Output artifact', r.output_artifact_path ? esc(r.output_artifact_path) : '<span class="dim">none</span>')}
${kv('Created', esc(r.created_at))}
${kv('Completed', esc(r.completed_at || '—'))}
${kv('Error', r.error ? `<span style="color:var(--err)">${esc(r.error)}</span>` : '<span class="dim">none</span>')}
</table></div>
<h2>Input text</h2><div class="panel"><pre>${esc(r.input_text || '(empty)')}</pre></div>
<h2>Output</h2><div class="panel"><pre>${esc(d.artifactContent || '(no artifact)')}</pre></div>
<h2>Prompt</h2>
<div class="panel"><details><summary>Full prompt sent to model</summary><pre>${esc(r.prompt || '(not recorded)')}</pre></details></div>`);
}

export function pageArtifacts(d: { artifacts: ArtifactRecord[]; filter: string; previewPath: string; previewContent: string }): string {
  const types = ['', ...allOutputTypes()];
  const filterSel = types
    .map((t) => `<option value="${t}"${t === d.filter ? ' selected' : ''}>${t || 'all types'}</option>`)
    .join('');
  const rows = d.artifacts.length
    ? d.artifacts
        .map(
          (a) => `<tr><td>${esc(a.title)}</td><td>${esc(a.type)}</td>
<td class="mono small dim">${esc(a.path)}</td>
<td class="small dim">${esc(a.created_at.slice(0, 19).replace('T', ' '))}</td>
<td><a href="/artifacts?type=${esc(d.filter)}&preview=${encodeURIComponent(a.path)}">preview</a> ·
<a href="/run?id=${esc(a.run_id)}">run</a></td></tr>`,
        )
        .join('')
    : '<tr><td colspan="5" class="dim">No artifacts recorded yet.</td></tr>';
  const preview = d.previewPath
    ? `<h2>Preview — <span class="mono">${esc(path.basename(d.previewPath))}</span></h2>
<div class="panel"><pre>${esc(d.previewContent)}</pre></div>`
    : '';
  return layout('Artifacts', '/artifacts', `
<h1>Artifacts</h1>
<div class="panel">
<form method="get" action="/artifacts"><label for="type">Filter by type</label>
<div class="row"><select name="type" id="type" onchange="this.form.submit()">${filterSel}</select></div></form>
<table><tr><th>File</th><th>Type</th><th>Path</th><th>Created</th><th></th></tr>${rows}</table>
</div>
${preview}`);
}

export const APP_ROOT_DISPLAY = APP_ROOT;
