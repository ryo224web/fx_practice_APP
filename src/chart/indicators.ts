// チャートのインジケーター（移動平均と RCI）。
// 確定した足の値は一度計算したら使い回し、作りかけの足（リプレイの最後の足）だけ毎回計算し直す。
// RCI は重いので、表示している辺りだけ計算する。

import { LineSeries, LineStyle, type IChartApi, type ISeriesApi, type LineData, type Time, type WhitespaceData } from 'lightweight-charts';
import { atr, ema, emaNext, rciAt, sma, zigzag, zigzagByMa, type ZigzagPoint } from '../indicators/calc';
import type { Bar } from '../core/candles';

export interface MaConfig {
  enabled: boolean;
  period: number;
  type: 'sma' | 'ema';
  color: string;
  /** 線の太さ（1〜4 px。無ければ 1） */
  width?: number;
}

export interface RciLine {
  enabled: boolean;
  period: number;
  color: string;
  /** 線の太さ（1〜4 px。無ければ 1） */
  width?: number;
}

/** RCI のサブウィンドウ 1 段（線は 4 本） */
export interface RciPane {
  enabled: boolean;
  lines: RciLine[];
}

/** ZigZag（MT4 の標準と同じ。Depth・Deviation（ポイント）・Backstep） */
export interface ZigzagConfig {
  enabled: boolean;
  /**
   * 区切り方。ma: 移動平均が少しでも逆を向いたら（A）。ma-atr: MA がその脚の端から ATR × atrMult 以上戻したら（B）。
   * ma-cross: MA が逆を向き、終値も MA の反対側に出たら（C）。mt4: MT4 の標準（Depth・Deviation・Backstep）
   */
  mode?: ZigzagMode;
  /** B の倍率（ATR の何倍戻したら区切るか） */
  atrMult?: number;
  /**
   * B の ATR の本数。14 本だと、大きく動いた後の静かな数時間で ATR が縮み、MA のわずかな下がりでも区切った。
   * 100 本ならその日の普段の値幅が基準になる（2026-11-05）
   */
  atrPeriod?: number;
  /**
   * B: MA がこの本数のあいだ高値（安値）を更新しなかったら、戻した幅が小さくても区切る（0 で使わない）。
   * ATR 100 本だけだと、MA が 20 本ほど横ばいになった押し（M1 04-20 17:53〜18:28）を 1 波にまとめた（2026-11-05）
   */
  stallBars?: number;
  /** A・B・C を色を変えて重ねる（どれが自分の数え方に近いか比べる） */
  compare?: boolean;
  maPeriod?: number;
  maType?: 'sma' | 'ema';
  depth: number;
  deviation: number;
  backstep: number;
  color: string;
  width?: number;
}

export type ZigzagMode = 'ma' | 'ma-atr' | 'ma-cross' | 'mt4';

/** 比べるときの A・B・C の見た目 */
export const ZIGZAG_COMPARE: { mode: ZigzagMode; label: string; color: string; width: 1 | 2 | 3 | 4; dashed?: boolean }[] = [
  { mode: 'ma', label: 'A', color: '#f0883e', width: 4 },
  { mode: 'ma-atr', label: 'B', color: '#db61a2', width: 2 },
  { mode: 'ma-cross', label: 'C', color: '#39c5cf', width: 2, dashed: true },
];

export interface IndicatorConfig {
  ma: MaConfig[];
  /** RCI のサブウィンドウ（上から順に。今は 2 段） */
  rci: RciPane[];
  /** 無ければ初めの設定（以前の保存） */
  zigzag?: ZigzagConfig;
}

export const DEFAULT_ZIGZAG: ZigzagConfig = { enabled: false, mode: 'ma-atr', maPeriod: 20, maType: 'sma', atrMult: 0.2, atrPeriod: 100, stallBars: 10, compare: false, depth: 12, deviation: 5, backstep: 3, color: '#f0883e', width: 2 };

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
  zigzag: DEFAULT_ZIGZAG,
};

/** RCI の段の数 */
export const RCI_PANES = 2;

/** 以前の保存（RCI が 1 段）を今の形にそろえる */
export function normalizeIndicators(cfg: IndicatorConfig | (Omit<IndicatorConfig, 'rci'> & { rci: RciPane | RciPane[] })): IndicatorConfig {
  const rci = Array.isArray(cfg.rci) ? cfg.rci.slice() : [cfg.rci];
  while (rci.length < RCI_PANES) rci.push(structuredClone(DEFAULT_INDICATORS.rci[rci.length]));
  const zigzag = { ...DEFAULT_ZIGZAG, ...(cfg as IndicatorConfig).zigzag };
  // 止まりの初期値は 12 本で始め、同じ日（2026-11-05）に 10 本へ変えた。12 は前の初期値がそのまま保存されたものなので 10 にする
  if (zigzag.stallBars === 12) zigzag.stallBars = 10;
  return { ma: cfg.ma, rci: rci.slice(0, RCI_PANES), zigzag };
}

/** 線の太さ（1〜4。チャートの部品が受け付ける形にする） */
const lineWidth = (w: number | undefined) => Math.max(1, Math.min(4, Math.round(w ?? 1))) as 1 | 2 | 3 | 4;

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
  /** ZigZag 用: 足（k 番目より後は使わない）と、今の足（作りかけ）の高値・安値、1 ポイントの値幅 */
  bars: readonly Bar[];
  partialHigh: number;
  partialLow: number;
  point: number;
}

interface Line {
  series: ISeriesApi<'Line'>;
  values: (input: IndicatorInput, j: number) => number;
}

export class IndicatorLayer {
  private config: IndicatorConfig = DEFAULT_INDICATORS;
  private lines: Line[] = [];
  private zz: { lines: { series: ISeriesApi<'Line'>; mode: ZigzagMode; shown: string }[]; cfg: ZigzagConfig } | null = null;
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
    for (const l of this.zz?.lines ?? []) this.chart.removeSeries(l.series);
    this.zz = null;
    while (this.chart.panes().length > 1) this.chart.removePane(1);

    // 価格の目盛りに名前や値の札は出さない（見づらいため）
    const common = { lineWidth: 1 as const, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
    for (const m of config.ma) {
      if (!m.enabled || !(m.period >= 1)) continue;
      // 縦の目盛りはローソク足だけで合わせる（TradingView の「価格チャートのみスケール」と同じ）。
      // 離れた移動平均まで収めようとすると、ローソク足が潰れて見えるため
      const series = this.chart.addSeries(LineSeries, { ...common, color: m.color, lineWidth: lineWidth(m.width), autoscaleInfoProvider: () => null }, 0);
      this.lines.push({ series, values: (inp, j) => this.maValue(inp, j, m) });
    }
    // ZigZag は山と谷だけの点を渡す（間は部品が直線でつなぐ）
    const zc = normalizeIndicators(config).zigzag!;
    if (zc.enabled) {
      const looks = zc.compare
        ? ZIGZAG_COMPARE
        : [{ mode: zc.mode ?? 'mt4', color: zc.color, width: lineWidth(zc.width), dashed: false }];
      const lines = looks.map((lk) => ({
        series: this.chart.addSeries(
          LineSeries,
          { ...common, color: lk.color, lineWidth: lk.width, lineStyle: lk.dashed ? LineStyle.Dashed : LineStyle.Solid, autoscaleInfoProvider: () => null, pointMarkersVisible: false },
          0,
        ),
        mode: lk.mode,
        shown: '',
      }));
      this.zz = { lines, cfg: zc };
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
          { ...common, color: l.color, lineWidth: lineWidth(l.width), autoscaleInfoProvider: () => ({ priceRange: { minValue: -100, maxValue: 100 } }) },
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
    this.renderZigzag(input);
  }

  /** ZigZag は最後の山・谷が先の足で動くので、毎回描いている範囲を計算し直す（山と谷の点が変わったときだけ渡す） */
  private renderZigzag(inp: IndicatorInput) {
    if (!this.zz) return;
    const { cfg, lines } = this.zz;
    const from = this.from;
    if (inp.k < from) return;
    // 移動平均・ATR は前の足から計算する（from の手前に期間の 3 倍あれば EMA も落ち着く。ATR はその本数より前から）
    const period = Math.max(1, Math.round(cfg.maPeriod ?? 20));
    const atrPeriod = Math.max(1, Math.round(cfg.atrPeriod ?? 100));
    const s0 = Math.max(0, from - Math.max(period * 3, atrPeriod + 10, 30));
    const n = inp.k - s0 + 1;
    const high = new Float64Array(n);
    const low = new Float64Array(n);
    const close = new Float64Array(n);
    for (let j = 0; j < n - 1; j++) {
      const b = inp.bars[s0 + j];
      high[j] = b.h;
      low[j] = b.l;
      close[j] = inp.closes[s0 + j];
    }
    high[n - 1] = inp.partialHigh;
    low[n - 1] = inp.partialLow;
    close[n - 1] = inp.partialClose;
    let ma: Float64Array | null = null;
    let tr: Float64Array | null = null;
    const start = from - s0;
    for (const line of lines) {
      let pts: ZigzagPoint[];
      if (line.mode === 'mt4') pts = zigzag(high, low, start, n - 1, Math.round(cfg.depth), cfg.deviation * inp.point, Math.round(cfg.backstep));
      else {
        ma ??= cfg.maType === 'ema' ? ema(close, period) : sma(close, period);
        if (line.mode === 'ma-atr') tr ??= atr(high, low, close, atrPeriod);
        pts = zigzagByMa(high, low, ma, start, n - 1, {
          kind: line.mode === 'ma-atr' ? 'atr' : line.mode === 'ma-cross' ? 'cross' : 'turn',
          close,
          atr: tr ?? undefined,
          atrMult: cfg.atrMult ?? 0.2,
          stall: line.mode === 'ma-atr' ? Math.max(0, Math.round(cfg.stallBars ?? 10)) : 0,
        });
      }
      // 山と谷の点が変わったときだけ渡す
      const sig = `${inp.key}:${from}:${pts.map((p) => `${p.i}=${p.price}`).join(',')}`;
      if (sig === line.shown) continue;
      line.shown = sig;
      // 時刻が前の点より後のものだけ渡す（同じ時刻があると部品が例外を出し、チャートの描き直しが途中で止まる）
      const data: LineData[] = [];
      for (const p of pts) {
        const time = inp.times[s0 + p.i];
        if (time === undefined || (data.length && (time as number) <= (data[data.length - 1].time as number))) continue;
        data.push({ time, value: p.price });
      }
      line.series.setData(data);
    }
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
