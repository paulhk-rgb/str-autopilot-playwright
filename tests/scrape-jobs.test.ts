import { afterEach, describe, expect, it } from 'vitest';

import {
  completeScrapeJob,
  createScrapeJob,
  failScrapeJob,
  getScrapeJob,
  __resetScrapeJobsForTesting,
} from '../src/lib/scrape-jobs';

afterEach(() => {
  __resetScrapeJobsForTesting();
});

describe('scrape-jobs', () => {
  it('creates a running job and reads it back', () => {
    const job = createScrapeJob('j1');
    expect(job.status).toBe('running');
    expect(getScrapeJob('j1')?.status).toBe('running');
  });

  it('returns null for an unknown job', () => {
    expect(getScrapeJob('missing')).toBeNull();
  });

  it('completes a running job with its result', () => {
    createScrapeJob('j2');
    completeScrapeJob('j2', { ok: true });
    const job = getScrapeJob('j2');
    expect(job?.status).toBe('complete');
    expect(job?.result).toEqual({ ok: true });
  });

  it('fails a running job with its error', () => {
    createScrapeJob('j3');
    failScrapeJob('j3', 'boom');
    const job = getScrapeJob('j3');
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('boom');
  });

  it('does not overwrite a terminal job', () => {
    createScrapeJob('j4');
    completeScrapeJob('j4', { first: true });
    failScrapeJob('j4', 'late');
    completeScrapeJob('j4', { second: true });
    const job = getScrapeJob('j4');
    expect(job?.status).toBe('complete');
    expect(job?.result).toEqual({ first: true });
  });
});
