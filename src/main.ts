import { CandlestickSeries, createChart, type CandlestickData, type UTCTimestamp } from 'lightweight-charts';
import { aggregate, TIMEFRAMES, type Bar, type Timeframe } from './core/candles';
import { sampleM1 } from './core/sample';
import { DEFAULT_SERVER_RULE, toDisplay, type DisplayZone } from './core/time';
import { loadManifest, loadMonths, type Manifest } from './data/store';
import './style.css';

const rule = DEFAULT_SERVER_RULE;
let tf: Timeframe = 'M15';
let zone: DisplayZone = 'jst';
let m1: Bar[] = [];
let digits = 3;

const chartEl = document.querySelector<HTMLDivElement>('#chart')!;
const statusEl = document.querySelector('#status')!;
const symbolEl = document.querySelector<HTMLSelectElement>('#symbol')!;
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
  series.applyOptions({ priceFormat: { type: 'price', precision: digits, minMove: 10 ** -digits } });
  series.setData(toChart(bars));
  if (bars.length < 200) chart.timeScale().fitContent();
  else chart.timeScale().scrollToRealTime();
  document.querySelectorAll<HTMLButtonElement>('[data-tf]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.tf === tf));
  });
}

async function loadSymbol(manifest: Manifest, symbol: string) {
  const t0 = performance.now();
  const info = manifest.symbols[symbol];
  statusEl.textContent = `${symbol.toUpperCase()} 読み込み中…`;
  const { bid } = await loadMonths(symbol, info.months, info.digits);
  m1 = bid;
  digits = info.digits;
  render();
  const first = info.months[0];
  const last = info.months[info.months.length - 1];
  statusEl.textContent = `${symbol.toUpperCase()} ${first}〜${last} / ${m1.length.toLocaleString()} 本 / 表示まで ${Math.round(performance.now() - t0)} ms`;
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

async function start() {
  const t0 = performance.now();
  const manifest = await loadManifest();
  const symbols = manifest ? Object.keys(manifest.symbols).filter((s) => manifest.symbols[s].months.length) : [];

  if (!manifest || symbols.length === 0) {
    // 実データがまだ無いときは仮データで表示する
    symbolEl.hidden = true;
    m1 = sampleM1(Date.UTC(2026, 9, 4, 21), 14 * 24 * 60);
    render();
    statusEl.textContent = `仮データ（npm run fetch-data で実データを取得） / 表示まで ${Math.round(performance.now() - t0)} ms`;
    return;
  }

  for (const s of symbols) symbolEl.add(new Option(s.toUpperCase(), s));
  symbolEl.addEventListener('change', () => loadSymbol(manifest, symbolEl.value));
  await loadSymbol(manifest, symbols.includes('usdjpy') ? 'usdjpy' : symbols[0]);
}

start().catch((e) => {
  statusEl.textContent = `エラー: ${e instanceof Error ? e.message : e}`;
});

function getCss(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
