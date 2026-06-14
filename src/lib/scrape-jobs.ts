import { performance } from 'node:perf_hooks';

/**
 * In-memory registry for asynchronous scrape jobs.
 *
 * A market scrape can run for minutes — far longer than the app-side serverless
 * function budget. Holding the HTTP connection open for the whole scrape means
 * the caller's function is killed mid-scrape while the worker keeps running,
 * orphaning the single-flight lock and triggering 409 retry storms.
 *
 * Instead the endpoint starts the scrape in the background, returns a job id
 * immediately, and the caller polls a status endpoint with short requests.
 * One machine serves one host, so a process-local Map is sufficient; jobs are
 * GC'd after a TTL so a crashed/abandoned poll can't leak memory.
 */

export type ScrapeJobStatus = 'running' | 'complete' | 'failed';

export interface ScrapeJob<T = unknown> {
  id: string;
  status: ScrapeJobStatus;
  result?: T;
  error?: string;
  startedAtMs: number;
  finishedAtMs?: number;
}

const JOB_TTL_MS = 30 * 60_000;

const jobs = new Map<string, ScrapeJob>();

function gc(nowMs: number): void {
  for (const [id, job] of jobs) {
    const ref = job.finishedAtMs ?? job.startedAtMs;
    if (nowMs - ref > JOB_TTL_MS) jobs.delete(id);
  }
}

export function createScrapeJob(id: string): ScrapeJob {
  const nowMs = performance.now();
  gc(nowMs);
  const job: ScrapeJob = { id, status: 'running', startedAtMs: nowMs };
  jobs.set(id, job);
  return job;
}

export function getScrapeJob(id: string): ScrapeJob | null {
  return jobs.get(id) ?? null;
}

export function completeScrapeJob(id: string, result: unknown): void {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return;
  job.status = 'complete';
  job.result = result;
  job.finishedAtMs = performance.now();
}

export function failScrapeJob(id: string, error: string): void {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return;
  job.status = 'failed';
  job.error = error;
  job.finishedAtMs = performance.now();
}

export function __resetScrapeJobsForTesting(): void {
  jobs.clear();
}
