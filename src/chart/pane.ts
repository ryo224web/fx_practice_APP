// チャート 1 枚（画面を分けたときの 1 区画）。
// 時間足とインジケーターはチャートごと。リプレイの時刻・注文・図形はすべてのチャートで共通。

import { CandlestickSeries, CrosshairMode, createChart, type CandlestickData, type IChartApi, type ISeriesApi, type Time } from 'lightweight-charts';
import { mergeBars, TIMEFRAMES, type Aggregated, type Bar, type Timeframe } from '../core/candles';
import { DrawingManager } from './drawings';
import { IndicatorLayer, type IndicatorConfig } from './indicators';
import { TimeMapper } from './mapper';
import { TradeOverlay } from './trades';

/** 時間足ごとに作った足（main.ts で作って全チャートで使い回す） */
export interface AggEntry {
  agg: Aggregated;
  times: number[];
  data: CandlestickData[];
  closes: Float64Array;
  chartTimes: Time[];
}

/** チャートが使う共通のデータ */
export interface PaneHost {
  agg(tf: Timeframe): AggEntry;
  dataVersion(): number;
  /** 最後に見えている 1 分足の添字 */
  cursor(): number;
  bid(): readonly Bar[];
  toChart(b: Bar): CandlestickData;
  symbol(): string;
  digits(): number;
  /** このチャートをクリックした（操作の対象にする） */
  activate(pane: ChartPane): void;
  /** 左端まで表示した（前の月を読み込む） */
  nearLeftEdge(): void;
  /** 右の余白（足の本数）を三角のつまみで変えた */
  setRightOffset(bars: number): void;
  /** 表示の範囲が変わった（スクロール・拡大縮小）。ほかのチャートを合わせるのに使う */
  rangeChanged(pane: ChartPane): void;
  /** マウスがこのチャートに入った（このチャートの動きにほかを合わせる） */
  lead(pane: ChartPane): void;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** 昇順の配列で、v 以下の最後の位置 */
export function lastLE(arr: readonly number[], v: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export class ChartPane {
  readonly chart: IChartApi;
  readonly series: ISeriesApi<'Candlestick'>;
  readonly mapper = new TimeMapper();
  readonly overlay: TradeOverlay;
  readonly drawings: DrawingManager;
  readonly indicators: IndicatorLayer;
  private readonly legend: HTMLElement;
  /** MT4 の「チャートの右端をずらす」三角のつまみ */
  private readonly shiftHandle: HTMLElement;
  private shown = { tf: '' as Timeframe | '', k: -1, version: -1 };
  private hovering = false;

  constructor(
    readonly index: number,
    readonly el: HTMLElement,
    private readonly host: PaneHost,
    public tf: Timeframe,
    indicators: IndicatorConfig,
  ) {
    const box = document.createElement('div');
    box.className = 'pane-chart';
    this.legend = document.createElement('div');
    this.legend.className = 'legend';
    this.shiftHandle = document.createElement('div');
    this.shiftHandle.className = 'shift-handle';
    this.shiftHandle.title = 'ドラッグして右側の余白を変える';
    el.append(box, this.legend, this.shiftHandle);

    this.chart = createChart(box, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: css('--fg') },
      grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 12, shiftVisibleRangeOnNewBar: true },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { locale: 'ja-JP' },
    });
    this.series = this.chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });
    // 注文の線のドラッグを図形より優先するため、先に登録する
    this.overlay = new TradeOverlay(box, this.mapper);
    this.series.attachPrimitive(this.overlay);
    this.drawings = new DrawingManager(box, this.mapper);
    this.series.attachPrimitive(this.drawings);
    this.indicators = new IndicatorLayer(this.chart);
    this.indicators.setConfig(indicators);

    el.addEventListener('mousedown', () => host.activate(this), true);
    el.addEventListener('mouseenter', () => host.lead(this));
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (r && r.from < 30) host.nearLeftEdge();
      this.placeShiftHandle();
      host.rangeChanged(this);
    });
    this.shiftHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const ts = this.chart.timeScale();
      const move = (ev: MouseEvent) => {
        const x = Math.max(40, Math.min(ts.width(), ev.clientX - box.getBoundingClientRect().left));
        host.setRightOffset(Math.round((ts.width() - x) / ts.options().barSpacing));
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    this.chart.subscribeCrosshairMove((p) => {
      const d = p.seriesData.get(this.series) as CandlestickData | undefined;
      this.hovering = !!(p.time && d);
      this.renderLegend(this.hovering && d ? d : null);
    });
  }

  setDigits(digits: number) {
    this.series.applyOptions({ priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits } });
    this.drawings.digits = digits;
  }

  /** 今の時刻までの足を表示する。reset なら全部描き直す（keepView なら見えている範囲を保つ） */
  render(reset = false, keepView = false) {
    if (this.el.hidden) return;
    const { agg, times, data, closes, chartTimes } = this.host.agg(this.tf);
    const cursor = this.host.cursor();
    const version = this.host.dataVersion();
    this.mapper.times = times;
    this.mapper.size = TIMEFRAMES[this.tf] * 60_000;
    this.drawings.tf = this.tf;
    const k = lastLE(agg.starts, cursor);
    const partial = this.host.toChart(mergeBars(this.host.bid(), agg.starts[k], cursor, agg.bars[k].t));
    if (reset || this.shown.tf !== this.tf || this.shown.version !== version || k < this.shown.k) {
      const view = keepView ? this.chart.timeScale().getVisibleRange() : null;
      this.series.setData([...data.slice(0, k), partial]);
      if (view) this.chart.timeScale().setVisibleRange(view);
    } else {
      for (let j = this.shown.k; j < k; j++) this.series.update(data[j]);
      this.series.update(partial);
    }
    this.shown = { tf: this.tf, k, version };
    this.indicators.render({ key: `${this.tf}:${version}`, closes, times: chartTimes, k, partialClose: partial.close });
    this.drawings.refresh();
    if (!this.hovering) this.renderLegend(null);
  }

  private renderLegend(bar: { open: number; high: number; low: number; close: number } | null) {
    if (this.el.hidden) return;
    let b = bar;
    if (!b) {
      const { agg } = this.host.agg(this.tf);
      const cursor = this.host.cursor();
      const k = lastLE(agg.starts, cursor);
      const m = mergeBars(this.host.bid(), agg.starts[k], cursor, agg.bars[k].t);
      b = { open: m.o, high: m.h, low: m.l, close: m.c };
    }
    const f = (p: number) => p.toFixed(this.host.digits());
    this.legend.innerHTML = `<b>${this.host.symbol().toUpperCase()},${this.tf}</b>　${f(b.open)} ${f(b.high)} ${f(b.low)} <b>${f(b.close)}</b>`;
  }

  /**
   * 連動の目印の時刻: 右の余白を除いた右端（最新の足を表示しているなら、その足の時刻）。
   * 時間足が違っても、この時刻をそろえれば同じ場面を見られる
   */
  anchorTime(): number | null {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    return r ? this.mapper.toTime(r.to - ts.options().rightOffset) : null;
  }

  /** 目印の時刻が同じ位置に来るように動かす（表示する本数＝拡大率はそのまま） */
  alignTo(time: number) {
    const ts = this.chart.timeScale();
    const r = ts.getVisibleLogicalRange();
    if (!r) return;
    const to = this.mapper.toLogical(time) + ts.options().rightOffset;
    if (Math.abs(to - r.to) < 0.01) return;
    ts.setVisibleLogicalRange({ from: to - (r.to - r.from), to });
  }

  /** from〜to（UTC）が真ん中あたりに収まるように表示を動かす */
  showTimeRange(from: number, to: number) {
    const a = this.mapper.toLogical(from);
    const b = this.mapper.toLogical(to);
    const pad = Math.max(15, (b - a) * 0.5);
    this.chart.timeScale().setVisibleLogicalRange({ from: a - pad, to: b + pad });
  }

  scrollToNow() {
    this.chart.timeScale().scrollToRealTime();
  }

  /** 右の余白（足の本数）。最新の足が見えている位置に戻す */
  setRightOffset(bars: number) {
    this.chart.timeScale().applyOptions({ rightOffset: bars });
    this.chart.timeScale().scrollToRealTime();
    this.placeShiftHandle();
  }

  /** つまみは「最新の足の右端 = 余白の始まり」に置く */
  private placeShiftHandle() {
    const ts = this.chart.timeScale();
    const o = ts.options();
    this.shiftHandle.style.left = `${ts.width() - o.rightOffset * o.barSpacing}px`;
  }

  zoom(factor: number) {
    const ts = this.chart.timeScale();
    ts.applyOptions({ barSpacing: Math.max(1, Math.min(60, ts.options().barSpacing * factor)) });
  }

  setActive(on: boolean) {
    this.el.classList.toggle('active', on);
  }
}
