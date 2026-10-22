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

/** RCI のサブウィンドウ 1 段（線は 4 本） */
export interface RciPane {
  enabled: boolean;
  lines: RciLine[];
}

export interface IndicatorConfig {
  ma: MaConfig[];
  /** RCI のサブウィンドウ（上から順に。今は 2 段） */
  rci: RciPane[];
}

const rciLines = (periods: number[]): RciLine[] =>
  periods.map((period, i) => ({ enabled: true, period, color: ['#f85149', '#3fb950', '#4493f8', '#e5a50a'][i] }));

export const DEFAULT_INDICATORS: IndicatorConfig = {
  ma: [
    { enabled: true, period: 6, type: 'sma', color: '#e5a50a' },
    { enabled: true, period: 20, type: 'sma', color: '#4493f8' },
    { enabled: true, period: 100, type: 'sma', color: '#a371f7' },
    { enabled: true, period: 200, type: 'sma', color: '#f85149' },
  ],
  rci: [
    { enabled: true, lines: rciLines([9, 26, 52, 78]) },
    { enabled: true, lines: rciLines([9, 26, 52, 78]) },
  ],
};

/** RCI の段の数 */
export const RCI_PANES = 2;

/** 以前の保存（RCI が 1 段）を今の形にそろえる */
export function normalizeIndicators(cfg: IndicatorConfig | (Omit<IndicatorConfig, 'rci'> & { rci: RciPane | RciPane[] })): IndicatorConfig {
  const rci = Array.isArray(cfg.rci) ? cfg.rci.slice() : [cfg.rci];
  while (rci.length < RCI_PANES) rci.push(structuredClone(DEFAULT_INDICATORS.rci[rci.length]));
  return { ma: cfg.ma, rci: rci.slice(0, RCI_PANES) };
}

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
  /** ローソク足のチャートに渡した最初の足の位置。これより古い値は描かない（横の位置がずれるため） */
  offset: number;
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
  /** 時間足ごとの計算済みの値（時間足を行き来しても計算し直さない。データが変わると key が変わる） */
  private saved = new Map<string, { ma: Map<string, Float64Array>; rci: Map<number, Float64Array> }>();
  private shown = { key: '', k: -1, from: -1 };
  private from = 0;
  private last: IndicatorInput | null = null;

  constructor(private readonly chart: IChartApi) {
    let pending = 0;
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
      // 左へ動かして計算済みの範囲を出たら、さらに前まで計算する（r はチャートの位置なので、渡した最初の足の分を足す）。
      // 見るのは次のフレームの範囲（時間足を変えた直後は、一瞬だけ前の時間足の位置＝遠い過去を指すことがあり、
      // それに合わせると何万本も計算して重くなる）
      if (pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        const r = chart.timeScale().getVisibleLogicalRange();
        const last = this.last;
        if (r && last && r.from + last.offset < this.from + 50 && this.from > last.offset) {
          this.from = Math.max(last.offset, Math.floor(r.from + last.offset) - WINDOW);
          this.render(last);
        }
      });
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
    // RCI は段ごとにサブウィンドウを 1 つ使う（表示する段だけ、上から 1, 2 …）
    let paneIndex = 0;
    for (const rp of normalizeIndicators(config).rci) {
      const lines = rp.lines.filter((l) => rp.enabled && l.enabled && l.period >= 2);
      if (!lines.length) continue;
      paneIndex++;
      lines.forEach((l, n) => {
        const series = this.chart.addSeries(
          LineSeries,
          { ...common, color: l.color, autoscaleInfoProvider: () => ({ priceRange: { minValue: -100, maxValue: 100 } }) },
          paneIndex,
        );
        if (n === 0) {
          // MT4 と同じく、目安の線はすべて点線
          for (const p of RCI_LEVELS) series.createPriceLine({ price: p, color: '#8d96a0', lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false, title: '' });
          // 目盛りは -100〜100。100 と -100 の数字が切れない程度の、ごくわずかな余白だけ付ける
          series.priceScale().applyOptions({ scaleMargins: { top: 0.04, bottom: 0.04 } });
        }
        this.lines.push({ series, values: (inp, j) => this.rciValue(inp, j, l.period) });
      });
    }
    // 高さは比率で決める（隠れているチャートは大きさが 0 なので、ピクセルでは決められない）。
    // ローソク足 3 : RCI 1 段ずつ 1。境目の線をドラッグすれば変えられる
    this.chart.panes()[0]?.setStretchFactor(3);
    for (let i = 1; i <= paneIndex; i++) this.chart.panes()[i]?.setStretchFactor(1);
    this.shown.key = '';
    if (this.last) this.render(this.last);
  }

  render(input: IndicatorInput) {
    this.last = input;
    if (input.key !== this.cacheKey) {
      this.cacheKey = input.key;
      let c = this.saved.get(input.key);
      if (!c) {
        c = { ma: new Map(), rci: new Map() };
        this.saved.set(input.key, c);
        // 持っておくのは最近の数個だけ
        while (this.saved.size > 6) this.saved.delete(this.saved.keys().next().value!);
      }
      this.maCache = c.ma;
      this.rciCache = c.rci;
      this.from = Math.max(0, input.k - WINDOW);
    }
    this.from = Math.max(input.offset, Math.min(this.from, Math.max(0, input.k - WINDOW)));
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
    if (j - m.period + 1 < 0) return NaN;
    if (m.type === 'ema' && j > m.period - 1) return emaNext(arr[j - 1], inp.partialClose, m.period);
    // SMA と、EMA の最初の値（SMA から始める）
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
