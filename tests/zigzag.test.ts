import { describe, expect, it } from 'vitest';
import { atr, sma, zigzag, zigzagByMa } from '../src/indicators/calc';

/** 終値の並びから、高値 = 終値 + 0.5・安値 = 終値 − 0.5 の足を作る */
function bars(closes: number[]) {
  return { high: closes.map((c) => c + 0.5), low: closes.map((c) => c - 0.5) };
}

/** 上り下りを交互に繰り返す値動き（山と谷の位置が分かっている） */
function wave(legs: number[], len: number) {
  const out: number[] = [];
  let v = 100;
  for (const d of legs) for (let i = 0; i < len; i++) out.push((v += d));
  return out;
}

describe('zigzag', () => {
  it('山と谷を交互に、その足の高値・安値で拾う', () => {
    const c = wave([1, -1, 1, -1, 1, -1], 20);
    const { high, low } = bars(c);
    const zz = zigzag(high, low, 0, c.length - 1, 12, 0, 3);
    // 山は 19・59・99 本目、谷は 39・79 本目（最初の谷・最後の谷は端なので、並びだけ見る）
    const tops = zz.filter((p) => p.price === high[p.i]).map((p) => p.i);
    const bottoms = zz.filter((p) => p.price === low[p.i] && !tops.includes(p.i)).map((p) => p.i);
    expect(tops).toEqual(expect.arrayContaining([19, 59, 99]));
    expect(bottoms).toEqual(expect.arrayContaining([39, 79]));
    for (let j = 1; j < zz.length; j++) {
      const up = zz[j].price > zz[j - 1].price;
      if (j > 1) expect(up).toBe(!(zz[j - 1].price > zz[j - 2].price));
    }
  });

  it('to より後の足は使わない', () => {
    const c = wave([1, -1, 1, -1], 20);
    const { high, low } = bars(c);
    const a = zigzag(high, low, 0, 50, 12, 0, 3);
    const changed = { high: high.slice(), low: low.slice() };
    for (let i = 51; i < c.length; i++) {
      changed.high[i] = 1e9;
      changed.low[i] = -1e9;
    }
    expect(zigzag(changed.high, changed.low, 0, 50, 12, 0, 3)).toEqual(a);
    expect(a.every((p) => p.i <= 50)).toBe(true);
  });

  it('Depth より短い小さな揺れは拾わない', () => {
    // 大きな上げ下げの途中に 3 本だけの小さな戻し
    const c = [...wave([1], 20), 119, 118, 119, ...wave([1], 20).map((v) => v + 19), ...wave([-1], 30).map((v) => v + 79)];
    const { high, low } = bars(c);
    const zz = zigzag(high, low, 0, c.length - 1, 12, 0, 3);
    expect(zz.some((p) => p.i >= 20 && p.i <= 23)).toBe(false);
  });
});


describe('zigzagByMa', () => {
  it('MA の向きが変わるごとに、その間の一番高い・安い足を結ぶ', () => {
    const c = wave([1, -1, 1, -1, 1], 40);
    const { high, low } = bars(c);
    const ma = sma(c, 20);
    const zz = zigzagByMa(high, low, ma, 0, c.length - 1);
    // 山は 39・119 本目、谷は 79・159 本目
    const idx = zz.map((p) => p.i);
    expect(idx).toEqual(expect.arrayContaining([39, 79, 119, 159]));
    expect(zz.find((p) => p.i === 39)!.price).toBe(high[39]);
    expect(zz.find((p) => p.i === 79)!.price).toBe(low[79]);
    // 山と谷が交互
    for (let j = 2; j < zz.length; j++) expect(zz[j].price > zz[j - 1].price).toBe(!(zz[j - 1].price > zz[j - 2].price));
    // 最後は今の脚の一番高い足
    expect(zz[zz.length - 1].i).toBe(c.length - 1);
  });

  it('MA が向きを変えない小さな戻しでは点を作らない', () => {
    const c = [...wave([1], 40), 138, 137, 138, ...wave([1], 30).map((v) => v + 38)];
    const { high, low } = bars(c);
    const zz = zigzagByMa(high, low, sma(c, 20), 0, c.length - 1);
    expect(zz.some((p) => p.i >= 40 && p.i <= 42)).toBe(false);
  });

  it('to より後の足は使わない', () => {
    const c = wave([1, -1, 1, -1], 40);
    const { high, low } = bars(c);
    const ma = sma(c, 20);
    const a = zigzagByMa(high, low, ma, 0, 100);
    const h2 = high.slice();
    for (let i = 101; i < h2.length; i++) h2[i] = 1e9;
    expect(zigzagByMa(h2, low, ma, 0, 100)).toEqual(a);
  });
});

describe('zigzagByMa の決め方', () => {
  // 上げ → 横ばいで MA が小さく揺れる → また上げ → 下げ
  const flat = Array.from({ length: 30 }, (_, i) => 140 + (i % 6 < 3 ? 0.3 : -0.3));
  const c = [...wave([1], 40), ...flat, ...wave([1], 30).map((v) => v + 40), ...wave([-1], 40).map((v) => v + 70)];
  const { high, low } = bars(c);
  const ma = sma(c, 20);
  const tr = atr(high, low, c, 14);

  it('A（turn）は横ばいの小さな揺れでも区切る。B（atr）は区切らない', () => {
    const a = zigzagByMa(high, low, ma, 0, c.length - 1, { kind: 'turn' });
    const b = zigzagByMa(high, low, ma, 0, c.length - 1, { kind: 'atr', atr: tr, atrMult: 1 });
    expect(a.length).toBeGreaterThan(b.length);
    // B は谷（最初）・山（上げの終わり）・今の足の 3 点
    expect(b.length).toBe(3);
    expect(b[1].i).toBe(99);
  });

  it('C（cross）は終値が MA の反対側に出るまで区切らない', () => {
    const cc = zigzagByMa(high, low, ma, 0, c.length - 1, { kind: 'cross', close: c });
    const a = zigzagByMa(high, low, ma, 0, c.length - 1, { kind: 'turn' });
    expect(cc.length).toBeLessThanOrEqual(a.length);
    expect(cc.map((p) => p.i)).toContain(99);
  });
});

describe('zigzagByMa の点の並び', () => {
  it('同じ足に 2 つの点を置かない（最初の点と最初の山・谷が重なるとき）', () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let trial = 0; trial < 200; trial++) {
      const n = 300;
      const close: number[] = [];
      let p = 100;
      for (let i = 0; i < n; i++) close.push((p += rnd() - 0.5));
      const high = close.map((c) => c + rnd() * 0.3);
      const low = close.map((c) => c - rnd() * 0.3);
      const ma = sma(close, 20);
      const from = Math.floor(rnd() * 40);
      for (const rule of [{ kind: 'turn' as const }, { kind: 'cross' as const, close }, { kind: 'atr' as const, atr: atr(high, low, close, 14), atrMult: 0.2 }]) {
        const z = zigzagByMa(high, low, ma, from, n - 1, rule);
        for (let i = 1; i < z.length; i++) expect(z[i].i).toBeGreaterThan(z[i - 1].i);
      }
    }
  });
});
