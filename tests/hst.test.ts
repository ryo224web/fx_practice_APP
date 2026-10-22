// MT4 のヒストリーファイル（.hst）の読み込み（scripts/lib/hst.mjs）
import { describe, expect, it } from 'vitest';
// @ts-expect-error 型定義のない .mjs
import { parseHst } from '../scripts/lib/hst.mjs';

function header(version: number, symbol: string, period: number, digits: number) {
  const h = Buffer.alloc(148);
  h.writeInt32LE(version, 0);
  h.write(symbol, 68, 'latin1');
  h.writeInt32LE(period, 80);
  h.writeInt32LE(digits, 84);
  return h;
}

describe('.hst を読む', () => {
  const t = Date.UTC(2026, 0, 30, 21, 59) / 1000;
  it('版 400（始値・安値・高値・終値の順）', () => {
    const r = Buffer.alloc(44);
    r.writeInt32LE(t, 0);
    [4889.635, 4889.485, 4895.118, 4895.118, 0.006].forEach((v, k) => r.writeDoubleLE(v, 4 + k * 8));
    const out = parseHst(Buffer.concat([header(400, 'XAUUSD', 1, 2), r]));
    expect(out).toMatchObject({ symbol: 'XAUUSD', period: 1, digits: 2 });
    expect(out.bars).toEqual([[t * 1000, 4889.635, 4895.118, 4889.485, 4895.118, 0.006]]);
  });
  it('版 401（始値・高値・安値・終値の順、時刻は 64 bit）', () => {
    const r = Buffer.alloc(60);
    r.writeBigInt64LE(BigInt(t), 0);
    [151.1, 151.3, 151.0, 151.2].forEach((v, k) => r.writeDoubleLE(v, 8 + k * 8));
    r.writeBigInt64LE(12n, 40);
    const out = parseHst(Buffer.concat([header(401, 'USDJPY', 1, 3), r, r]));
    expect(out.bars).toEqual([
      [t * 1000, 151.1, 151.3, 151.0, 151.2, 12],
      [t * 1000, 151.1, 151.3, 151.0, 151.2, 12],
    ]);
  });
  it('知らない版は読まない', () => {
    expect(() => parseHst(header(500, 'X', 1, 2))).toThrow();
  });
});
