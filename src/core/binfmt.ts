import type { Bar } from './candles';

// ファイル形式の説明は scripts/lib/binfmt.mjs を参照
const FIELDS = 9;

export interface PriceBars {
  bid: Bar[];
  ask: Bar[];
}

export function decodeMonth(buf: ArrayBuffer, digits: number): PriceBars {
  const v = new Int32Array(buf);
  const scale = 10 ** digits;
  const n = v.length / FIELDS;
  const bid: Bar[] = new Array(n);
  const ask: Bar[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * FIELDS;
    const t = v[o] * 60_000;
    bid[i] = { t, o: v[o + 1] / scale, h: v[o + 2] / scale, l: v[o + 3] / scale, c: v[o + 4] / scale };
    ask[i] = { t, o: v[o + 5] / scale, h: v[o + 6] / scale, l: v[o + 7] / scale, c: v[o + 8] / scale };
  }
  return { bid, ask };
}
