import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { WatermarkStore } from '../src/playwright/watermark-store';

describe('WatermarkStore', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmstore-'));
    path = join(dir, 'watermarks.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty map when file does not exist', () => {
    const s = new WatermarkStore(path);
    expect(s.load()).toEqual({});
  });

  it('returns empty map for empty file', () => {
    writeFileSync(path, '');
    const s = new WatermarkStore(path);
    expect(s.load()).toEqual({});
  });

  it('returns empty map for malformed JSON', () => {
    writeFileSync(path, '{ not json }');
    const s = new WatermarkStore(path);
    expect(s.load()).toEqual({});
  });

  it('returns empty map when JSON parses to a non-object', () => {
    writeFileSync(path, '"a string"');
    const s = new WatermarkStore(path);
    expect(s.load()).toEqual({});
    writeFileSync(path, '[1, 2, 3]');
    expect(s.load()).toEqual({});
  });

  it('loads valid JSON object with numeric values', () => {
    writeFileSync(path, JSON.stringify({ '1234': 1700000000000, '5678': 1700000001000 }));
    const s = new WatermarkStore(path);
    expect(s.load()).toEqual({ '1234': 1700000000000, '5678': 1700000001000 });
  });

  it('coerces string-valued numbers; drops non-finite + negative', () => {
    writeFileSync(
      path,
      JSON.stringify({ a: '100', b: 'not-a-number', c: -1, d: 0, e: 50.5 }),
    );
    const s = new WatermarkStore(path);
    const loaded = s.load();
    expect(loaded.a).toBe(100);
    expect('b' in loaded).toBe(false);
    expect('c' in loaded).toBe(false);
    expect(loaded.d).toBe(0);
    expect(loaded.e).toBe(50.5);
  });

  it('save+load round-trip', () => {
    const s = new WatermarkStore(path);
    const map = { '1111': 1, '2222': 2 };
    s.save(map);
    expect(s.load()).toEqual(map);
  });

  it('save uses same-directory tmp file and atomic rename (no .tmp leftover)', () => {
    const s = new WatermarkStore(path);
    s.save({ '1': 100 });
    // After save, only the target should exist (no .tmp residue).
    const fs = require('fs') as typeof import('fs');
    expect(fs.existsSync(path)).toBe(true);
    expect(fs.existsSync(`${path}.tmp`)).toBe(false);
  });

  it('merge advances per-thread max only', () => {
    const s = new WatermarkStore(path);
    const prev = { a: 100, b: 200, c: 50 };
    const updates = { a: 150, b: 100, d: 999 };
    expect(s.merge(prev, updates)).toEqual({
      a: 150, // advanced
      b: 200, // not regressed
      c: 50, // unchanged
      d: 999, // new
    });
  });

  it('merge ignores non-finite + negative updates', () => {
    const s = new WatermarkStore(path);
    const prev = { a: 100 };
    const updates: Record<string, number> = { a: NaN, b: -1, c: Infinity, d: 200 };
    expect(s.merge(prev, updates)).toEqual({ a: 100, d: 200 });
  });
});
