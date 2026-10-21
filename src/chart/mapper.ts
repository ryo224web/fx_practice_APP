import type { ITimeScaleApi, Logical, Time } from 'lightweight-charts';

/**
 * 時刻（UTC）とチャートの横位置（足の番号。小数も可）の変換。
 * 図形は時刻で保存するので、時間足を切り替えても同じ場所に描ける。
 * 足と足の間は比例で、最後の足より右（未来）は時間足の長さで延ばす。
 */
export class TimeMapper {
  constructor(
    /** 表示中の足の開始時刻（UTC、昇順） */
    public times: readonly number[] = [],
    /** 1 本の長さ（ミリ秒） */
    public size = 60_000,
  ) {}

  toLogical(t: number): number {
    const n = this.times.length;
    if (n === 0) return 0;
    if (t <= this.times[0]) return (t - this.times[0]) / this.size;
    if (t >= this.times[n - 1]) return n - 1 + (t - this.times[n - 1]) / this.size;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.times[mid] <= t) lo = mid;
      else hi = mid;
    }
    // 週末などの空白は足 1 本分に縮めて扱う
    const frac = Math.min(1, (t - this.times[lo]) / this.size);
    return lo + frac;
  }

  toTime(logical: number): number {
    const n = this.times.length;
    if (n === 0) return 0;
    if (logical <= 0) return this.times[0] + logical * this.size;
    if (logical >= n - 1) return this.times[n - 1] + (logical - (n - 1)) * this.size;
    const i = Math.floor(logical);
    return this.times[i] + (logical - i) * Math.min(this.size, this.times[i + 1] - this.times[i]);
  }

  /** 時刻 → 画面の x 座標。ライブラリは小数の位置を扱えない（0 を返す）ので、前後の足の間を補う */
  toX(ts: ITimeScaleApi<Time>, t: number): number | null {
    const l = this.toLogical(t);
    const i = Math.floor(l);
    const a = ts.logicalToCoordinate(i as Logical);
    if (a === null) return null;
    if (l === i) return a;
    const b = ts.logicalToCoordinate((i + 1) as Logical);
    return b === null ? a : a + (b - a) * (l - i);
  }
}
