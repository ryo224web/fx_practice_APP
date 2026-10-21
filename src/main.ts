import { CandlestickSeries, createChart, type CandlestickData, type UTCTimestamp } from 'lightweight-charts';
import { aggregate, TIMEFRAMES, type Bar, type Timeframe } from './core/candles';
import { sampleM1 } from './core/sample';
import { DEFAULT_SERVER_RULE, toDisplay, type DisplayZone } from './core/time';
import './style.css';

const t0 = performance.now();
const rule = DEFAULT_SERVER_RULE;
let tf: Timeframe = 'M15';
let zone: DisplayZone = 'jst';

// 仮データ: 2026-10-05（月）から 2 週間分
const m1 = sampleM1(Date.UTC(2026, 9, 4, 21), 14 * 24 * 60);

const chartEl = document.querySelector<HTMLDivElement>('#chart')!;
const chart = createChart(chartEl, {
  autoSize: true,
  layout: { background: { color: 'transparent' }, textColor: getCss('--fg') },
  grid: { vertLines: { color: getCss('--grid') }, horzLines: { color: getCss('--grid') } },
  timeScale: { timeVisible: true, secondsVisible: false },
  localization: { locale: 'ja-JP' },
});
const series = chart.addSeries(CandlestickSeries, {
  upColor: '#26a69a',
  downColor: '#ef5350',
  borderVisible: false,
  wickUpColor: '#26a69a',
  wickDownColor: '#ef5350',
  priceFormat: { type: 'price', precision: 3, minMove: 0.001 },
});

function toChart(bars: Bar[]): CandlestickData[] {
  return bars.map((b) => ({
    time: (toDisplay(b.t, zone, rule) / 1000) as UTCTimestamp,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
  }));
}

function render() {
  const bars = aggregate(m1, tf, rule);
  series.setData(toChart(bars));
  if (bars.length < 200) chart.timeScale().fitContent();
  else chart.timeScale().scrollToRealTime();
  document.querySelectorAll<HTMLButtonElement>('[data-tf]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.tf === tf));
  });
}

const tfBar = document.querySelector('#timeframes')!;
for (const name of Object.keys(TIMEFRAMES) as Timeframe[]) {
  const btn = document.createElement('button');
  btn.textContent = name;
  btn.dataset.tf = name;
  btn.addEventListener('click', () => {
    tf = name;
    render();
  });
  tfBar.append(btn);
}

document.querySelector<HTMLSelectElement>('#zone')!.addEventListener('change', (e) => {
  zone = (e.target as HTMLSelectElement).value as DisplayZone;
  render();
});

render();
document.querySelector('#status')!.textContent = `仮データ ${m1.length.toLocaleString()} 本 / 表示まで ${Math.round(performance.now() - t0)} ms`;

function getCss(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
