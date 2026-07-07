// Approval-gated external actions. The rule:
//
//   The workbench may PREPARE actions. Humans APPROVE writes.
//
// Proposing an action never touches the target — it produces an approval
// record (with a full preview) that sits in the approvals table until a human
// approves or rejects it on the /approvals page. Execution happens only on
// approval, only through this module, and only against the two currently
// supported targets: the configured Obsidian vault (file copy, never
// overwrites) and the configured Git repo (git add -A + git commit, no push).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { dataDir, resolveConfigPath, type Config } from './config.ts';
import { allowedReadRoots, checkDir, ensureDir, isPathAllowed } from './paths.ts';
import { getStore, type ApprovalRecord } from './store.ts';

export type ActionType = 'obsidian-write' | 'git-commit';

const GIT_TIMEOUT_MS = 30_000;
const MAX_PREVIEW = 20_000;

// --- tiny line diff (LCS) for the obsidian-write preview -----------------------
function lineDiff(oldText: string, newText: string): string {
  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);
  // LCS table (files are notes, not huge — fine for preview purposes)
  const m = a.length;
  const n = b.length;
  if (m * n > 4_000_000) return '(files too large to diff — showing new content only)\n' + newText;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < m) out.push(`- ${a[i++]}`);
  while (j < n) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

function git(repo: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: repo, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim();
      resolve({ ok: !err, out: out || (err ? String(err.message) : '') });
    });
  });
}

function sanitizeRelPath(rel: string): string {
  // Forward-slash segments only; strips drive letters, '..', empty segments.
  return rel
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.trim().replace(/[<>:"|?*]/g, '-'))
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

// --- Propose ------------------------------------------------------------------

export function proposeObsidianWrite(
  cfg: Config,
  args: { artifactPath: string; subdir?: string; filename?: string },
): ApprovalRecord | { error: string } {
  const vault = resolveConfigPath(cfg.obsidianVaultDir);
  if (!vault) return { error: 'No Obsidian vault configured in Settings.' };
  if (checkDir(vault).status !== 'writable') return { error: `Obsidian vault is not writable: ${vault}` };

  const source = path.resolve(args.artifactPath);
  if (!isPathAllowed(source, allowedReadRoots(cfg))) {
    return { error: 'Artifact is outside the folders this app may read.' };
  }
  let content: string;
  try {
    content = fs.readFileSync(source, 'utf8');
  } catch {
    return { error: `Artifact not readable: ${source}` };
  }

  const subdir = sanitizeRelPath(args.subdir ?? 'inbox');
  const filename = sanitizeRelPath(args.filename || path.basename(source)) || path.basename(source);
  const target = path.resolve(vault, subdir, filename);
  if (!isPathAllowed(target, [vault])) return { error: 'Target escapes the vault root.' };

  let preview: string;
  let note = '';
  if (fs.existsSync(target)) {
    let existing = '';
    try {
      existing = fs.readFileSync(target, 'utf8');
    } catch {
      /* treat as new */
    }
    note = 'A file already exists at the target. It will NOT be overwritten — the new file gets a numeric suffix. Diff against the existing file:';
    preview = `${note}\n\n${lineDiff(existing, content)}`;
  } else {
    preview = `New file (nothing at target yet). Content to be written:\n\n${content}`;
  }

  const store = getStore(dataDir(cfg));
  const approval = store.createApproval({
    action: 'obsidian-write',
    target,
    payload: JSON.stringify({ source, target }),
    preview: preview.slice(0, MAX_PREVIEW),
  });
  store.audit('approval.proposed', { id: approval.id, action: approval.action, target });
  return approval;
}

export async function proposeGitCommit(cfg: Config, args: { message: string }): Promise<ApprovalRecord | { error: string }> {
  const repo = resolveConfigPath(cfg.gitRepoDir);
  if (!repo) return { error: 'No Git repo configured in Settings (gitRepoDir).' };
  if (!fs.existsSync(path.join(repo, '.git'))) return { error: `Not a Git repository (no .git): ${repo}` };
  const message = args.message.trim().slice(0, 500);
  if (!message) return { error: 'Commit message is empty.' };

  const status = await git(repo, ['status', '--porcelain']);
  if (!status.ok) return { error: `git status failed: ${status.out}` };
  if (!status.out.trim()) return { error: 'Nothing to commit — working tree is clean.' };
  const diffStat = await git(repo, ['diff', '--stat']);
  const diffStatStaged = await git(repo, ['diff', '--stat', '--cached']);

  const preview = [
    `Repo: ${repo}`,
    `Commit message: ${message}`,
    '',
    'Changed files (git status --porcelain):',
    status.out,
    '',
    'Diff stat (unstaged):',
    diffStat.out || '(none)',
    '',
    'Diff stat (staged):',
    diffStatStaged.out || '(none)',
    '',
    'On approval the workbench runs: git add -A && git commit -m <message>. It never pushes.',
  ].join('\n');

  const store = getStore(dataDir(cfg));
  const approval = store.createApproval({
    action: 'git-commit',
    target: repo,
    payload: JSON.stringify({ repo, message }),
    preview: preview.slice(0, MAX_PREVIEW),
  });
  store.audit('approval.proposed', { id: approval.id, action: approval.action, target: repo });
  return approval;
}

// --- Execute (called only from the approval decision endpoint) ------------------

/** The ONLY code path that writes into the Obsidian vault. Never overwrites. */
function approvedVaultWrite(cfg: Config, source: string, target: string): string {
  const vault = resolveConfigPath(cfg.obsidianVaultDir);
  if (!vault || !isPathAllowed(target, [vault])) {
    throw new Error('Approved target is no longer inside the configured vault.');
  }
  const content = fs.readFileSync(source, 'utf8');
  ensureDir(path.dirname(target));
  let finalPath = target;
  const ext = path.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  let n = 2;
  while (fs.existsSync(finalPath)) {
    finalPath = `${stem}-${n}${ext}`;
    n++;
  }
  fs.writeFileSync(finalPath, content, 'utf8');
  return finalPath;
}

export async function executeApproval(cfg: Config, approvalId: string, decision: 'approve' | 'reject'): Promise<{ ok: boolean; result: string }> {
  const store = getStore(dataDir(cfg));
  const approval = store.getApproval(approvalId);
  if (!approval) return { ok: false, result: 'Approval not found.' };
  if (approval.status !== 'pending') return { ok: false, result: `Approval already ${approval.status}.` };

  if (decision === 'reject') {
    store.decideApproval(approval.id, 'rejected', 'Rejected by user — nothing was written.');
    store.audit('approval.rejected', { id: approval.id, action: approval.action, target: approval.target });
    return { ok: true, result: 'Rejected — nothing was written.' };
  }

  let payload: Record<string, string>;
  try {
    payload = JSON.parse(approval.payload);
  } catch {
    store.decideApproval(approval.id, 'rejected', 'Corrupt payload — action not executed.');
    return { ok: false, result: 'Corrupt payload — action not executed.' };
  }

  try {
    let result: string;
    if (approval.action === 'obsidian-write') {
      const written = approvedVaultWrite(cfg, payload.source, payload.target);
      result = `Written to ${written}`;
    } else if (approval.action === 'git-commit') {
      const repo = resolveConfigPath(cfg.gitRepoDir);
      if (!repo || path.resolve(repo) !== path.resolve(payload.repo)) {
        throw new Error('Configured Git repo changed since this approval was proposed. Propose again.');
      }
      const add = await git(repo, ['add', '-A']);
      if (!add.ok) throw new Error(`git add failed: ${add.out}`);
      const commit = await git(repo, ['commit', '-m', payload.message]);
      if (!commit.ok) throw new Error(`git commit failed: ${commit.out}`);
      result = commit.out.split('\n')[0] || 'Commit created.';
    } else {
      throw new Error(`Unknown action type: ${approval.action}`);
    }
    store.decideApproval(approval.id, 'approved', result);
    store.audit('approval.executed', { id: approval.id, action: approval.action, target: approval.target, result });
    return { ok: true, result };
  } catch (err) {
    const msg = (err as Error).message;
    // Execution failed — keep it decided (approved) but record the failure so
    // it cannot be silently retried without a fresh proposal + preview.
    store.decideApproval(approval.id, 'approved', `EXECUTION FAILED: ${msg}`);
    store.audit('approval.failed', { id: approval.id, action: approval.action, error: msg });
    return { ok: false, result: msg };
  }
}
