import type { Bar } from './candles';

/**
 * 動作確認用の仮データ（ランダムウォークの 1 分足）。
 * 週末はおおよそ（UTC 金曜 21:00〜日曜 21:00）除外する。本物のデータはステップ 4 で入れる。
 */
export function sampleM1(startUtc: number, minutes: number, start = 150, seed = 1): Bar[] {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const bars: Bar[] = [];
  let price = start;
  for (let i = 0; i < minutes; i++) {
    const t = startUtc + i * 60_000;
    const d = new Date(t);
    const dow = d.getUTCDay();
    const h = d.getUTCHours();
    if (dow === 6 || (dow === 5 && h >= 21) || (dow === 0 && h < 21)) continue;
    const o = price;
    const c = o + (rand() - 0.5) * 0.04;
    const h2 = Math.max(o, c) + rand() * 0.02;
    const l2 = Math.min(o, c) - rand() * 0.02;
    bars.push({ t, o, h: h2, l: l2, c });
    price = c;
  }
  return bars;
}
