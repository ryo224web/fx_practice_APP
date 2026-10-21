// チャートのインジケーター（移動平均と RCI）。
// 確定した足の値は一度計算したら使い回し、作りかけの足（リプレイの最後の足）だけ毎回計算し直す。
// RCI は重いので、表示している辺りだけ計算する。

import { LineSeries, LineStyle, type IChartApi, type ISeriesApi, type LineData, type Time, type WhitespaceData } from 'lightweight-charts';
import { ema, emaNext, rciAt, sma } from '../indicators/calc';

export interface MaConfig {
  enabled: boolean;
  period: number;
  type: 'sma' | 'ema';
  color: string;
}

export interface RciLine {
  enabled: boolean;
  period: number;
  color: string;
}

export interface IndicatorConfig {
  ma: MaConfig[];
  rci: { enabled: boolean; lines: RciLine[] };
}

export const DEFAULT_INDICATORS: IndicatorConfig = {
  ma: [
    { enabled: true, period: 6, type: 'sma', color: '#e5a50a' },
    { enabled: true, period: 20, type: 'sma', color: '#4493f8' },
    { enabled: true, period: 100, type: 'sma', color: '#a371f7' },
    { enabled: true, period: 200, type: 'sma', color: '#f85149' },
  ],
  rci: {
    enabled: true,
    lines: [
      { enabled: true, period: 9, color: '#f85149' },
      { enabled: true, period: 26, color: '#3fb950' },
      { enabled: true, period: 52, color: '#4493f8' },
      { enabled: true, period: 78, color: '#e5a50a' },
    ],
  },
};

/** RCI の目安の線 */
const RCI_LEVELS = [95, 80, 0, -80, -95];

/** 一度に計算する RCI の本数（表示を左へ動かすとさらに計算する） */
const WINDOW = 2000;

export interface IndicatorInput {
  /** 時間足とデータの版。変わったら計算し直す */
  key: string;
  /** すべての足の終値（未来の足も含むが、k 番目より後は使わない） */
  closes: Float64Array;
  times: Time[];
  /** 今の足（作りかけ）の位置と終値 */
  k: number;
  partialClose: number;
}

interface Line {
  series: ISeriesApi<'Line'>;
  values: (input: IndicatorInput, j: number) => number;
}

export class IndicatorLayer {
  private config: IndicatorConfig = DEFAULT_INDICATORS;
  private lines: Line[] = [];
  private cacheKey = '';
  private maCache = new Map<string, Float64Array>();
  private rciCache = new Map<number, Float64Array>();
  private shown = { key: '', k: -1, from: -1 };
  private from = 0;
  private last: IndicatorInput | null = null;

  constructor(private readonly chart: IChartApi) {
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      // 左へ動かして計算済みの範囲を出たら、さらに前まで計算する
      if (r && this.last && r.from < this.from + 50 && this.from > 0) {
        this.from = Math.max(0, Math.floor(r.from) - WINDOW);
        this.render(this.last);
      }
    });
  }

  setConfig(config: IndicatorConfig) {
    this.config = config;
    for (const l of this.lines) this.chart.removeSeries(l.series);
    this.lines = [];
    while (this.chart.panes().length > 1) this.chart.removePane(1);

    // 価格の目盛りに名前や値の札は出さない（見づらいため）
    const common = { lineWidth: 1 as const, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
    for (const m of config.ma) {
      if (!m.enabled || !(m.period >= 1)) continue;
      const series = this.chart.addSeries(LineSeries, { ...common, color: m.color }, 0);
      this.lines.push({ series, values: (inp, j) => this.maValue(inp, j, m) });
    }
    const rci = config.rci.lines.filter((l) => config.rci.enabled && l.enabled && l.period >= 2);
    rci.forEach((l, n) => {
      const series = this.chart.addSeries(
        LineSeries,
        { ...common, color: l.color, autoscaleInfoProvider: () => ({ priceRange: { minValue: -100, maxValue: 100 } }) },
        1,
      );
      if (n === 0) {
        // MT4 と同じく、目安の線はすべて点線
        for (const p of RCI_LEVELS) series.createPriceLine({ price: p, color: '#8d96a0', lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false, title: '' });
        // 目盛りは -100〜100。100 と -100 の数字が切れない程度の、ごくわずかな余白だけ付ける
        series.priceScale().applyOptions({ scaleMargins: { top: 0.04, bottom: 0.04 } });
      }
      this.lines.push({ series, values: (inp, j) => this.rciValue(inp, j, l.period) });
    });
    // 高さは比率で決める（隠れているチャートは大きさが 0 なので、ピクセルでは決められない）。
    // 境目の線をドラッグすれば変えられる
    if (rci.length) {
      this.chart.panes()[0]?.setStretchFactor(3);
      this.chart.panes()[1]?.setStretchFactor(1);
    }
    this.shown.key = '';
    if (this.last) this.render(this.last);
  }

  render(input: IndicatorInput) {
    this.last = input;
    if (input.key !== this.cacheKey) {
      this.cacheKey = input.key;
      this.maCache.clear();
      this.rciCache.clear();
      this.from = Math.max(0, input.k - WINDOW);
    }
    this.from = Math.min(this.from, Math.max(0, input.k - WINDOW));
    const { k } = input;
    const full = this.shown.key !== input.key || this.shown.from !== this.from || k < this.shown.k;
    for (const l of this.lines) {
      const point = (j: number): LineData | WhitespaceData => {
        const v = l.values(input, j);
        return Number.isFinite(v) ? { time: input.times[j], value: v } : { time: input.times[j] };
      };
      if (full) {
        const data: (LineData | WhitespaceData)[] = [];
        for (let j = this.from; j <= k; j++) data.push(point(j));
        l.series.setData(data);
      } else {
        for (let j = Math.max(this.shown.k, this.from); j <= k; j++) l.series.update(point(j));
      }
    }
    this.shown = { key: input.key, k, from: this.from };
  }

  private maValue(inp: IndicatorInput, j: number, m: MaConfig): number {
    const id = `${m.type}${m.period}`;
    let arr = this.maCache.get(id);
    if (!arr) {
      arr = m.type === 'ema' ? ema(inp.closes, m.period) : sma(inp.closes, m.period);
      this.maCache.set(id, arr);
    }
    if (j < inp.k) return arr[j];
    // 作りかけの足は、その時点の終値で計算する
    if (m.type === 'ema') return j === 0 ? inp.partialClose : emaNext(arr[j - 1], inp.partialClose, m.period);
    if (j - m.period + 1 < 0) return NaN;
    let sum = inp.partialClose;
    for (let q = j - m.period + 1; q < j; q++) sum += inp.closes[q];
    return sum / m.period;
  }

  private rciValue(inp: IndicatorInput, j: number, period: number): number {
    if (j >= inp.k) return rciAt(inp.closes, j, period, inp.partialClose);
    let arr = this.rciCache.get(period);
    if (!arr) {
      arr = new Float64Array(inp.closes.length).fill(NaN);
      this.rciCache.set(period, arr);
    }
    if (Number.isNaN(arr[j])) arr[j] = rciAt(inp.closes, j, period);
    return arr[j];
  }
}
