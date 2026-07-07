// CLI entry points that don't need the web server:
//
//   npm run brief   one-shot morning brief -> data/briefs + stdout
//   npm run watch   background mode: regenerate the brief when notes change
//
// Both are read-only over your notes; the only write is the brief file.
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) {
  console.error(`Requires Node.js 24+ (you are running ${process.version}).`);
  process.exit(1);
}

import fs from 'node:fs';
import { loadConfig } from './config.ts';
import { buildBrief, watchDirs, writeBrief } from './brief.ts';

const command = process.argv[2] ?? 'brief';

if (command === 'brief') {
  const cfg = loadConfig();
  const { path: written, brief } = writeBrief(cfg);
  console.log(brief.content);
  console.error(`\nBrief written to ${written}`);
} else if (command === 'watch') {
  const cfg = loadConfig();
  const dirs = watchDirs(cfg);
  console.log('Morning-brief watch mode. Watching for note changes in:');
  for (const d of dirs) console.log(`  ${d}`);
  console.log('Press Ctrl+C to stop.\n');

  const initial = writeBrief(cfg);
  console.log(`[${new Date().toISOString().slice(11, 19)}] brief written to ${initial.path}`);

  let timer: NodeJS.Timeout | null = null;
  let lastContent = initial.brief.content;
  const regenerate = () => {
    timer = null;
    try {
      const freshCfg = loadConfig(); // settings may have changed while watching
      const brief = buildBrief(freshCfg);
      if (brief.content === lastContent) return; // nothing meaningful changed
      lastContent = brief.content;
      const { path: written } = writeBrief(freshCfg);
      console.log(`[${new Date().toISOString().slice(11, 19)}] notes changed — brief rewritten to ${written}`);
    } catch (err) {
      console.error(`[watch] regeneration failed: ${(err as Error).message}`);
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(regenerate, 2000); // debounce editor save bursts
  };
  for (const d of dirs) {
    try {
      fs.watch(d, { persistent: true }, schedule);
    } catch (err) {
      console.error(`[watch] cannot watch ${d}: ${(err as Error).message}`);
    }
  }
} else {
  console.error(`Unknown command: ${command}. Use "brief" or "watch".`);
  process.exit(1);
}
