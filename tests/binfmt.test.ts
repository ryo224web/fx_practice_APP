import { describe, expect, it } from 'vitest';
import { decodeMonth } from '../src/core/binfmt';
// @ts-expect-error 型定義のない .mjs
import { encodeMonth } from '../scripts/lib/binfmt.mjs';

describe('価格ファイルの形式', () => {
  it('書き出して読み戻すと同じ値になる', () => {
    const t = Date.UTC(2026, 9, 20, 0, 0);
    const bid = [
      [t, 158.123, 158.2, 158.1, 158.15],
      [t + 60_000, 158.15, 158.16, 158.14, 158.155],
    ];
    const ask = [
      [t, 158.126, 158.203, 158.103, 158.153],
      [t + 60_000, 158.153, 158.163, 158.143, 158.158],
    ];
    const bytes: Uint8Array = encodeMonth(bid, ask, 3);
    const { bid: b, ask: a } = decodeMonth(bytes.slice().buffer as ArrayBuffer, 3);
    expect(b).toEqual([
      { t, o: 158.123, h: 158.2, l: 158.1, c: 158.15 },
      { t: t + 60_000, o: 158.15, h: 158.16, l: 158.14, c: 158.155 },
    ]);
    expect(a[0]?.o).toBe(158.126);
  });

  it('Ask のない時刻の足は Bid だけ残し、Ask は null にする', () => {
    const t = Date.UTC(2026, 9, 20);
    const bytes: Uint8Array = encodeMonth([[t, 1, 1, 1, 1], [t + 60_000, 2, 2, 2, 2]], [[t, 1, 1, 1, 1]], 5);
    const { bid, ask } = decodeMonth(bytes.slice().buffer as ArrayBuffer, 5);
    expect(bid).toHaveLength(2);
    expect(ask[0]?.o).toBe(1);
    expect(ask[1]).toBeNull();
  });
});
