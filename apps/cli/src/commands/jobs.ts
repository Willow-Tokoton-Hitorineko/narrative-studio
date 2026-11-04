import { InvalidArgumentError } from '@narrative-studio/contracts';
import { openProject } from '@narrative-studio/core';
import {
  JobRunner,
  JobStore,
  type JobContext,
  type JobPayloadValue,
} from '@narrative-studio/jobs';
import { rebuildProjection } from '@narrative-studio/projection';
import type { CliContext } from '../context.js';
import { flagString, requireFlag, type ParsedArgs } from '../flags.js';
import type { CommandResult } from './types.js';

function resolveProjectId(vaultDir: string, context: CliContext): string {
  return openProject(vaultDir, context.projectId).project.project_id;
}

function parsePayload(raw: string | null): Record<string, JobPayloadValue> {
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidArgumentError('--payload must be valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidArgumentError('--payload must be a JSON object of primitives');
  }
  const output: Record<string, JobPayloadValue> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new InvalidArgumentError('--payload values must be strings, numbers, booleans or null');
    }
    output[key] = value as JobPayloadValue;
  }
  return output;
}

function createStore(vaultDir: string, context: CliContext): { store: JobStore; projectId: string } {
  const projectId = resolveProjectId(vaultDir, context);
  const store = new JobStore({ appDataRoot: context.appDataRoot, projectId });
  return { store, projectId };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function demoCount(context: JobContext): Promise<Record<string, unknown>> {
  const total = 20;
  for (let step = 1; step <= total; step += 1) {
    if (context.isCancelled()) throw new Error('cancelled');
    context.reportProgress((step / total) * 100, `scanned ${step}/${total} chunks`);
    await delay(40);
  }
  return { chunks: total, simulated: true };
}

export async function commandJob(args: ParsedArgs, context: CliContext): Promise<CommandResult> {
  const vaultDir = requireFlag(args, 'vault');
  const subcommand = args.subcommand;
  const { store, projectId } = createStore(vaultDir, context);

  if (subcommand === 'submit') {
    const kind = requireFlag(args, 'kind', 'job kind');
    const job = store.submit({ kind, payload: parsePayload(flagString(args, 'payload')) });
    return {
      data: { ...job },
      human: [`Queued job ${job.job_id} (${job.kind}) for ${projectId}.`],
    };
  }

  if (subcommand === 'list') {
    const jobs = store.list();
    return {
      data: { project_id: projectId, jobs },
      human:
        jobs.length === 0
          ? ['No jobs for this project.']
          : jobs.map((job) => `${job.job_id}  ${job.status.padEnd(9)}  ${job.progress}%  ${job.kind}`),
    };
  }

  if (subcommand === 'cancel') {
    const jobId = requireFlag(args, 'id', 'job id');
    const job = store.requestCancel(jobId);
    return {
      data: { ...job },
      human: [`Cancellation requested for ${job.job_id} (status ${job.status}).`],
    };
  }

  if (subcommand === 'run') {
    const runner = new JobRunner(store);
    runner.register('projection.rebuild', async () =>
      rebuildProjection({
        vaultDir,
        projectId,
        appDataRoot: context.appDataRoot,
        logger: context.logger,
        now: context.now,
      }),
    );
    runner.register('demo.count', demoCount);

    const jobId = flagString(args, 'id');
    const record = jobId ? await runner.run(jobId) : await runner.runNext();
    if (!record) {
      return { data: { project_id: projectId, job: null }, human: ['No queued jobs.'] };
    }
    return {
      data: { ...record },
      human: [`Job ${record.job_id} finished with status ${record.status}.`],
    };
  }

  throw new InvalidArgumentError('Usage: ns job submit|list|cancel|run …');
}
