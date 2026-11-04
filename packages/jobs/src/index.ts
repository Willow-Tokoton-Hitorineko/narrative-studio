/**
 * Device-local, cancellable job queue (model-free in Gate 0).
 *
 * Jobs live in AppDataRoot, never in the Vault: losing them loses no story
 * text. The queue is intentionally single-process; cancellation is signalled
 * through a marker file as well as an in-process AbortSignal, so a second
 * terminal can cancel a running analysis without sharing memory.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomHex } from '@narrative-studio/contracts';
import {
  ensureAppDataRoot,
  ensureDir,
  jobsDir,
  pathExists,
  readFileBytes,
  resolveAppDataRoot,
  writeFileAtomic,
} from '@narrative-studio/core';

export const JOB_SCHEMA_VERSION = 1 as const;

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export type JobPayloadValue = string | number | boolean | null;

export interface JobRecord {
  schema_version: typeof JOB_SCHEMA_VERSION;
  job_id: string;
  project_id: string;
  kind: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  progress: number;
  message: string | null;
  payload: Record<string, JobPayloadValue>;
  result: unknown;
  error: string | null;
  cancel_requested: boolean;
}

export interface SubmitJobOptions {
  kind: string;
  payload?: Record<string, JobPayloadValue>;
  now?: () => Date;
}

function jobIdFor(now: () => Date): string {
  return `job_${now().getTime().toString(36)}${randomHex(4)}`;
}

function parseJob(raw: string, file: string): JobRecord {
  try {
    return JSON.parse(raw) as JobRecord;
  } catch {
    throw new Error(`Job file is corrupt: ${file}`);
  }
}

export class JobStore {
  readonly appDataRoot: string;
  readonly projectId: string;
  readonly directory: string;
  private readonly now: () => Date;

  constructor(options: { appDataRoot: string; projectId: string; now?: () => Date }) {
    this.appDataRoot = ensureAppDataRoot(resolveAppDataRoot(options.appDataRoot)).root;
    this.projectId = options.projectId;
    this.now = options.now ?? (() => new Date());
    this.directory = jobsDir(this.appDataRoot, options.projectId);
    ensureDir(this.directory);
  }

  private fileFor(jobId: string): string {
    return path.join(this.directory, `${jobId}.json`);
  }

  private cancelMarker(jobId: string): string {
    return path.join(this.directory, `${jobId}.cancel`);
  }

  submit(options: SubmitJobOptions): JobRecord {
    const createdAt = (options.now ?? this.now)().toISOString();
    const job: JobRecord = {
      schema_version: JOB_SCHEMA_VERSION,
      job_id: jobIdFor(this.now),
      project_id: this.projectId,
      kind: options.kind,
      status: 'queued',
      created_at: createdAt,
      updated_at: createdAt,
      started_at: null,
      finished_at: null,
      progress: 0,
      message: null,
      payload: options.payload ?? {},
      result: null,
      error: null,
      cancel_requested: false,
    };
    this.save(job);
    return job;
  }

  save(job: JobRecord): JobRecord {
    const updated: JobRecord = { ...job, updated_at: this.now().toISOString() };
    writeFileAtomic(this.fileFor(job.job_id), `${JSON.stringify(updated, null, 2)}\n`);
    return updated;
  }

  get(jobId: string): JobRecord {
    const raw = readFileBytes(this.fileFor(jobId));
    if (!raw) throw new Error(`Job not found: ${jobId}`);
    return parseJob(raw.toString('utf8'), this.fileFor(jobId));
  }

  list(): JobRecord[] {
    const jobs: JobRecord[] = [];
    for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(this.directory, entry.name);
      const raw = readFileBytes(file);
      if (!raw) continue;
      jobs.push(parseJob(raw.toString('utf8'), file));
    }
    jobs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return jobs;
  }

  requestCancel(jobId: string): JobRecord {
    const job = this.get(jobId);
    fs.writeFileSync(this.cancelMarker(jobId), new Date().toISOString(), 'utf8');
    const updated = this.save({
      ...job,
      cancel_requested: true,
      status: job.status === 'queued' ? 'cancelled' : job.status,
      finished_at: job.status === 'queued' ? this.now().toISOString() : job.finished_at,
    });
    return updated;
  }

  isCancelRequested(jobId: string): boolean {
    return pathExists(this.cancelMarker(jobId));
  }

  clearCancel(jobId: string): void {
    try {
      fs.rmSync(this.cancelMarker(jobId), { force: true });
    } catch {
      /* best effort */
    }
  }
}

export interface JobContext {
  job: JobRecord;
  signal: AbortSignal;
  reportProgress: (progress: number, message?: string | null) => void;
  isCancelled: () => boolean;
}

export type JobHandler = (context: JobContext) => Promise<unknown> | unknown;

export class JobRunner {
  private readonly store: JobStore;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly now: () => Date;

  constructor(store: JobStore, options: { now?: () => Date } = {}) {
    this.store = store;
    this.now = options.now ?? (() => new Date());
  }

  register(kind: string, handler: JobHandler): void {
    this.handlers.set(kind, handler);
  }

  async runNext(): Promise<JobRecord | null> {
    const next = this.store
      .list()
      .filter((job) => job.status === 'queued')
      .sort((a, b) => (a.created_at < b.created_at ? -1 : 1))[0];
    if (!next) return null;
    return this.run(next.job_id);
  }

  async run(jobId: string): Promise<JobRecord> {
    const job = this.store.get(jobId);
    if (job.status !== 'queued') {
      throw new Error(`Job ${jobId} is ${job.status}, not queued`);
    }
    const handler = this.handlers.get(job.kind);
    if (!handler) {
      const failed = this.store.save({
        ...job,
        status: 'failed',
        error: `No handler registered for job kind "${job.kind}"`,
        finished_at: this.now().toISOString(),
      });
      return failed;
    }

    const controller = new AbortController();
    let current = this.store.save({
      ...job,
      status: 'running',
      started_at: this.now().toISOString(),
      progress: 0,
      message: 'starting',
    });

    const poll = setInterval(() => {
      if (this.store.isCancelRequested(jobId)) controller.abort();
    }, 40);
    poll.unref();

    const context: JobContext = {
      job: current,
      signal: controller.signal,
      reportProgress: (progress, message = null) => {
        current = this.store.save({
          ...current,
          progress: Math.max(0, Math.min(100, Math.round(progress))),
          message,
        });
      },
      isCancelled: () => this.store.isCancelRequested(jobId) || controller.signal.aborted,
    };

    try {
      const result = await handler(context);
      const cancelled = this.store.isCancelRequested(jobId);
      current = this.store.save({
        ...current,
        status: cancelled ? 'cancelled' : 'done',
        progress: cancelled ? current.progress : 100,
        result: cancelled ? null : result,
        error: null,
        finished_at: this.now().toISOString(),
        message: cancelled ? 'cancelled by user' : 'done',
      });
    } catch (error) {
      const cancelled = this.store.isCancelRequested(jobId);
      current = this.store.save({
        ...current,
        status: cancelled ? 'cancelled' : 'failed',
        error: cancelled ? null : error instanceof Error ? error.message : String(error),
        result: null,
        finished_at: this.now().toISOString(),
        message: cancelled ? 'cancelled by user' : 'failed',
      });
    } finally {
      clearInterval(poll);
      this.store.clearCancel(jobId);
    }
    return current;
  }
}

export function jobStoreFor(options: {
  appDataRoot?: string | null;
  projectId: string;
  now?: () => Date;
}): JobStore {
  return new JobStore({
    appDataRoot: resolveAppDataRoot(options.appDataRoot),
    projectId: options.projectId,
    now: options.now,
  });
}
