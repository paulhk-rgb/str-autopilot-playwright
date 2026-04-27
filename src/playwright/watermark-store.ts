/**
 * Per-thread watermark persistence.
 *
 * Per spec §2 `Watermark`: `{ rawThreadId: latestEmittedCreatedAtMs }` JSON map,
 * updated after callback-ack (api mode) or after side-channel intersection check
 * (shadow mode). Used by cursor-walk gating.
 *
 * Persistence semantics on Fly: `data/` is rootfs and ephemeral on machine restart
 * unless a [mounts] block is added in fly.toml. See spec §2 `Watermark` P1-M.
 *
 * Atomic write per Opus R1 audit: write `<dir>/watermarks.json.tmp` then
 * `rename(2)` to target. tmp file MUST live in same directory as target to avoid
 * cross-mount EXDEV when a Fly volume is later added.
 *
 * Defensive load: missing file, empty file, malformed JSON, or wrong type all
 * produce an empty map without crashing; spec §2 P1-M.4.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export type WatermarkMap = Record<string, number>;

export class WatermarkStore {
  constructor(private readonly path: string) {}

  load(): WatermarkMap {
    if (!existsSync(this.path)) return {};
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      return {};
    }
    if (!text.trim()) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: WatermarkMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k !== 'string') continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n >= 0) out[k] = n;
    }
    return out;
  }

  save(map: WatermarkMap): void {
    const dir = dirname(this.path);
    const tmp = `${this.path}.tmp`;
    // Same-directory tmp file → rename(2) is atomic and safe even if a Fly
    // volume gets mounted at the parent (cross-mount EXDEV impossible).
    void dir;
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  /**
   * Merge new high-water marks per thread into existing map. Only advances
   * (never regresses) per-thread max. Returns the post-merge map without
   * persisting; caller decides when to save.
   */
  merge(prev: WatermarkMap, updates: WatermarkMap): WatermarkMap {
    const out: WatermarkMap = { ...prev };
    for (const [k, v] of Object.entries(updates)) {
      if (!Number.isFinite(v) || v < 0) continue;
      const cur = out[k];
      if (typeof cur !== 'number' || v > cur) {
        out[k] = v;
      }
    }
    return out;
  }
}
