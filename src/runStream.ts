// Ephemeral, in-memory live-output buffers for in-flight runs. Each run gets
// a small ring buffer of raw provider output lines plus an EventEmitter so
// the SSE route in server.ts can both replay what's already happened and
// subscribe to what happens next. Nothing here is persisted — once a run
// finishes, its stream is evicted after a short grace period (enough time
// for a client that's mid-reconnect to still see the final `done` event).
import { EventEmitter } from 'node:events';
import type { WorkflowResult } from './workflows.ts';

const MAX_BUFFERED_LINES = 500;
const EVICT_AFTER_MS = 10 * 60 * 1000; // 10 minutes after completion

export class RunStream extends EventEmitter {
  readonly runId: string;
  private lines: string[] = [];
  private truncatedCount = 0;
  done = false;
  result: WorkflowResult | null = null;

  constructor(runId: string) {
    super();
    this.runId = runId;
    // Live streams can have many listeners over reconnects/heartbeats.
    this.setMaxListeners(50);
  }

  push(line: string): void {
    if (this.done) return;
    this.lines.push(line);
    if (this.lines.length > MAX_BUFFERED_LINES) {
      this.lines.shift();
      this.truncatedCount++;
    }
    this.emit('line', line);
  }

  /** Lines buffered so far, for replay to a client that just connected. */
  bufferedLines(): string[] {
    return this.truncatedCount > 0
      ? [`[${this.truncatedCount} earlier line(s) truncated]`, ...this.lines]
      : [...this.lines];
  }

  finish(result: WorkflowResult): void {
    if (this.done) return;
    this.done = true;
    this.result = result;
    this.emit('done', result);
    setTimeout(() => runStreams.delete(this.runId), EVICT_AFTER_MS).unref();
  }
}

const runStreams = new Map<string, RunStream>();

export function createRunStream(runId: string): RunStream {
  const stream = new RunStream(runId);
  runStreams.set(runId, stream);
  return stream;
}

export function getRunStream(runId: string): RunStream | undefined {
  return runStreams.get(runId);
}
