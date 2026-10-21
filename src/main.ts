import { CandlestickSeries, CrosshairMode, createChart, type CandlestickData, type UTCTimestamp } from 'lightweight-charts';
import { DrawingManager, type DrawingKind } from './chart/drawings';
import { TimeMapper } from './chart/mapper';
import { TradeOverlay, type LineEdit } from './chart/trades';
import { aggregateWithIndex, mergeBars, TIMEFRAMES, type Aggregated, type Bar, type Timeframe } from './core/candles';
import { formatMoney, formatPrice, formatTime, fromLocalInput, toLocalInput } from './core/format';
import { sampleM1 } from './core/sample';
import { symbolSpec, type SymbolSpec } from './core/symbols';
import { DEFAULT_SERVER_RULE, toDisplay, type DisplayZone } from './core/time';
import { loadManifest, type Manifest } from './data/store';
import { MarketData } from './replay/market';
import { loadState, saveState, type AppState, type TestState } from './state';
import { Account, replayAccount, type Action, type FillEvent, type NewAction, type PendingType, type PriceFeed } from './trade/account';
import { renderHistory, renderStats, renderTrade, type TerminalTab } from './ui/terminal';
import './style.css';

const rule = DEFAULT_SERVER_RULE;
/** 再生速度（1 秒に進む 1 分足の本数） */
const SPEEDS = [1, 2, 5, 15, 30, 60, 240, 720, 1440];
const DEFAULT_BALANCE = 1_000_000;
const DEFAULT_LEVERAGE = 500;
const DAY_BARS = 1440;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const chartEl = $('#chart');
const statusEl = $('#status');
const symbolEl = $<HTMLSelectElement>('#symbol');
const legendEl = $('#legend');
const clockEl = $('#clock');
const playBtn = $<HTMLButtonElement>('#play');
const speedEl = $<HTMLInputElement>('#speed');
const lotsEl = $<HTMLInputElement>('#lots');
const termBody = $('#terminal-body');
const ctxMenu = $('#ctx-menu');

// ---------------- チャート ----------------
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const chart = createChart(chartEl, {
  autoSize: true,
  layout: { background: { color: 'transparent' }, textColor: css('--fg') },
  grid: { vertLines: { color: css('--grid') }, horzLines: { color: css('--grid') } },
  timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 12, shiftVisibleRangeOnNewBar: true },
  crosshair: { mode: CrosshairMode.Normal },
  localization: { locale: 'ja-JP' },
});
const series = chart.addSeries(CandlestickSeries, {
  upColor: '#26a69a',
  downColor: '#ef5350',
  borderVisible: false,
  wickUpColor: '#26a69a',
  wickDownColor: '#ef5350',
});
const mapper = new TimeMapper();
// 注文の線のドラッグを図形より優先するため、先に登録する
const overlay = new TradeOverlay(chartEl, mapper);
series.attachPrimitive(overlay);
const drawings = new DrawingManager(chartEl, mapper);
series.attachPrimitive(drawings);
// 開発中の調査用（本番のビルドには入らない）
if (import.meta.env.DEV) Object.assign(window, { __fx: { chart, series, mapper, drawings } });

// ---------------- 状態 ----------------
let state: AppState;
let manifest: Manifest | null = null;
let md: MarketData;
let usd: MarketData | null = null;
let spec: SymbolSpec;
let account: Account;
/** 最後に見えている 1 分足の添字 */
let cursor = 0;
let playing = false;
let dataVersion = 0;
const aggCache = new Map<Timeframe, { agg: Aggregated; times: number[]; data: CandlestickData[]; version: number }>();
const shown = { tf: '' as Timeframe | '', k: -1, version: -1 };
let loadingEarlier = false;
let loadingLater = false;
let lastTerminalRender = 0;

const feed: PriceFeed = {
  get bid() {
    return md.bid;
  },
  get ask() {
    return md.ask;
  },
  jpyRate,
};

function jpyRate(i: number): number {
  if (spec.quote === 'JPY') return 1;
  if (!usd || usd.bid.length === 0) return NaN;
  const j = usd.indexAtOrBefore(md.bid[i].t);
  if (j < 0) return NaN;
  const usdjpy = usd.bid[j].c;
  if (spec.quote === 'USD') return usdjpy;
  if (spec.name.startsWith('USD')) return usdjpy / md.bid[i].c;
  return NaN;
}

function test(): TestState {
  return state.test!;
}

function defaultState(): AppState {
  return {
    version: 1,
    symbol: 'usdjpy',
    tf: 'M15',
    zone: 'jst',
    cursor: 0,
    speed: 3,
    pauseOnFill: true,
    lots: 0.1,
    terminalTab: 'trade',
    terminalHeight: 220,
    test: null,
    drawings: {},
  };
}

function save(now = false) {
  saveState(state, now);
}

// ---------------- データ ----------------
async function openSymbol(symbol: string, around: number | null) {
  if (manifest && manifest.symbols[symbol]) {
    const info = manifest.symbols[symbol];
    md = new MarketData(symbol, info.digits, info.months);
    if (around === null) await md.loadRange(Math.max(0, info.months.length - 3), info.months.length - 1);
    else await md.loadAround(around, 2, 1);
  } else {
    md = MarketData.fromBars('sample', 3, sampleM1(Date.UTC(2026, 9, 4, 21), 14 * DAY_BARS), 0.003);
  }
  spec = symbolSpec(md.symbol === 'sample' ? 'usdjpy' : md.symbol, md.digits);
  usd = null;
  await syncUsd();
  dataChanged();
  series.applyOptions({ priceFormat: { type: 'price', precision: md.digits, minMove: 10 ** -md.digits } });
  drawings.digits = md.digits;
  drawings.setDrawings(state.drawings[md.symbol] ?? []);
}

/** 円に換算するために USDJPY を同じ期間だけ読み込む */
async function syncUsd() {
  if (!manifest || spec.quote === 'JPY' || md.symbol === 'usdjpy' || !manifest.symbols.usdjpy) return;
  usd ??= new MarketData('usdjpy', manifest.symbols.usdjpy.digits, manifest.symbols.usdjpy.months);
  const months = md.loadedMonths;
  const from = usd.months.findIndex((m) => m >= months[0]);
  let to = usd.months.findLastIndex((m) => m <= months[months.length - 1]);
  if (from < 0 || to < 0) return;
  if (to < from) to = from;
  await usd.loadRange(from, to);
}

/** 読み込んだ範囲が変わった・表示時刻を変えたときに呼ぶ */
function dataChanged() {
  dataVersion++;
  aggCache.clear();
  if (state.cursor) cursor = Math.max(0, md.indexAtOrBefore(state.cursor));
}

function getAgg(tf: Timeframe) {
  let c = aggCache.get(tf);
  if (!c || c.version !== dataVersion) {
    const agg = aggregateWithIndex(md.bid, tf, rule);
    c = { agg, times: agg.bars.map((b) => b.t), data: agg.bars.map(toChart), version: dataVersion };
    aggCache.set(tf, c);
  }
  return c;
}

function toChart(b: Bar): CandlestickData {
  return { time: (toDisplay(b.t, state.zone, rule) / 1000) as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c };
}

/** 昇順の配列で、v 以下の最後の位置 */
function lastLE(arr: readonly number[], v: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (arr[mid] <= v) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function minIndex(): number {
  return Math.max(0, md.indexAtOrBefore(test().baseline.time));
}

// ---------------- 口座 ----------------
function rebuildAccount() {
  const t = test();
  const r = replayAccount(spec, { leverage: t.leverage }, t.baseline, t.actions, feed, minIndex(), cursor);
  account = r.account;
  t.actions = r.actions;
}

function act(a: NewAction): boolean {
  const action = { ...a, t: md.bid[cursor].t } as Action;
  const err = account.apply(feed, cursor, action);
  if (err) {
    toast(err);
    return false;
  }
  test().actions.push(action);
  refresh();
  return true;
}

function notifyFills(events: FillEvent[]) {
  const msgs = events.map((e) => {
    if (e.kind === 'open') return `#${e.ticket} が約定しました`;
    const h = account.history.findLast((x) => x.kind === 'trade' && x.ticket === e.ticket);
    const pl = h && h.kind === 'trade' ? `（${formatMoney(h.profit)} 円）` : '';
    return `#${e.ticket} が ${e.kind === 'sl' ? 'S/L' : 'T/P'} で決済されました${pl}`;
  });
  toast(msgs.join(' / '));
}

// ---------------- 時間を進める・戻す ----------------
/** target 番目の 1 分足まで動く。約定で止まったら true */
function goTo(target: number): boolean {
  target = Math.max(minIndex(), Math.min(md.bid.length - 1, target));
  let stopped = false;
  if (target > cursor) {
    for (let i = cursor + 1; i <= target; i++) {
      const ev = account.processBar(feed, i);
      if (ev.length) {
        notifyFills(ev);
        if (state.pauseOnFill) {
          target = i;
          stopped = true;
          break;
        }
      }
    }
    cursor = target;
  } else if (target < cursor) {
    // 戻した時刻より後の操作は取り消して、口座を計算し直す
    cursor = target;
    const t = md.bid[cursor].t;
    test().actions = test().actions.filter((a) => a.t <= t);
    rebuildAccount();
  }
  state.cursor = md.bid[cursor].t;
  refresh();
  maybeLoadLater();
  return stopped;
}

/** 今の時間足で 1 本進む（作りかけの足なら、その足の終わりまで） */
function stepBar(dir: 1 | -1) {
  const { agg } = getAgg(state.tf);
  const k = lastLE(agg.starts, cursor);
  const endOf = (j: number) => (j + 1 < agg.starts.length ? agg.starts[j + 1] - 1 : md.bid.length - 1);
  if (dir > 0) goTo(cursor < endOf(k) ? endOf(k) : endOf(k + 1));
  else goTo(k > 0 ? endOf(k - 1) : cursor);
}

function setPlaying(on: boolean) {
  playing = on;
  playBtn.textContent = on ? '❚❚' : '▶';
  playBtn.setAttribute('aria-pressed', String(on));
  if (on) {
    let last = 0;
    let acc = 0;
    const frame = (ts: number) => {
      if (!playing) return;
      const dt = last ? Math.min(ts - last, 1000) : 0;
      last = ts;
      acc += (dt / 1000) * SPEEDS[state.speed];
      const n = Math.min(Math.floor(acc), 5000);
      if (n > 0) {
        acc -= n;
        const atEnd = cursor >= md.bid.length - 1;
        if (atEnd && !md.hasLater && !loadingLater) {
          setPlaying(false);
          toast('データの最後に着きました');
          return;
        }
        if (goTo(cursor + n)) {
          setPlaying(false);
          return;
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  } else if (account) {
    renderTerminal(true);
    save();
  }
}

function maybeLoadLater() {
  if (loadingLater || !md.hasLater || cursor < md.bid.length - 3 * DAY_BARS) return;
  loadingLater = true;
  const mdNow = md;
  md.loadLater(1)
    .then(syncUsd)
    .then(() => {
      if (md !== mdNow) return;
      dataChanged();
      renderChart(true, true);
    })
    .finally(() => (loadingLater = false));
}

function loadEarlier() {
  if (loadingEarlier || !md.hasEarlier) return;
  loadingEarlier = true;
  const mdNow = md;
  md.loadEarlier(3)
    .then(syncUsd)
    .then(() => {
      if (md !== mdNow) return;
      dataChanged();
      renderChart(true, true);
    })
    .finally(() => (loadingEarlier = false));
}

chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
  if (r && r.from < 30) loadEarlier();
});

// ---------------- 表示 ----------------
function renderChart(reset = false, keepView = false) {
  const { agg, times, data } = getAgg(state.tf);
  mapper.times = times;
  mapper.size = TIMEFRAMES[state.tf] * 60_000;
  const k = lastLE(agg.starts, cursor);
  const partial = toChart(mergeBars(md.bid, agg.starts[k], cursor, agg.bars[k].t));
  if (reset || shown.tf !== state.tf || shown.version !== dataVersion || k < shown.k) {
    const view = keepView ? chart.timeScale().getVisibleRange() : null;
    series.setData([...data.slice(0, k), partial]);
    if (view) chart.timeScale().setVisibleRange(view);
  } else {
    for (let j = shown.k; j < k; j++) series.update(data[j]);
    series.update(partial);
  }
  shown.tf = state.tf;
  shown.k = k;
  shown.version = dataVersion;
  drawings.refresh();
}

function renderQuotes() {
  const bid = md.bid[cursor].c;
  const ask = md.ask[cursor].c;
  const est = md.askEstimated[cursor] === 1;
  $('#bid-big').textContent = formatPrice(bid, md.digits);
  $('#ask-big').textContent = formatPrice(ask, md.digits);
  $('#spread').textContent = `${((ask - bid) / spec.pip).toFixed(1)} pips${est ? '（推定）' : ''}`;
  $('#spread').title = est ? 'この時間の Ask はデータに無いため、直前のスプレッドで推定しています' : '';
  clockEl.textContent = formatTime(md.bid[cursor].t + 60_000, state.zone, rule);
  overlay.update({
    positions: account.positions,
    orders: account.orders,
    history: account.history,
    ask,
    askEstimated: est,
    digits: md.digits,
  });
  if (!hovering) showLegend(null);
}

let hovering = false;
function showLegend(bar: { open: number; high: number; low: number; close: number } | null) {
  const { agg } = getAgg(state.tf);
  const k = lastLE(agg.starts, cursor);
  const b = bar ?? (() => {
    const m = mergeBars(md.bid, agg.starts[k], cursor, agg.bars[k].t);
    return { open: m.o, high: m.h, low: m.l, close: m.c };
  })();
  const f = (p: number) => formatPrice(p, md.digits);
  legendEl.innerHTML = `<b>${md.symbol.toUpperCase()},${state.tf}</b>　${f(b.open)} ${f(b.high)} ${f(b.low)} <b>${f(b.close)}</b>`;
}

chart.subscribeCrosshairMove((p) => {
  const d = p.seriesData.get(series) as CandlestickData | undefined;
  hovering = !!(p.time && d);
  showLegend(hovering && d ? d : null);
});

function renderTerminal(force = false) {
  const now = performance.now();
  if (!force && playing && now - lastTerminalRender < 200) return;
  lastTerminalRender = now;
  const scroll = termBody.scrollTop;
  const ctx = { account, feed, index: cursor, digits: md.digits, time: (t: number) => formatTime(t, state.zone, rule) };
  const tab = state.terminalTab as TerminalTab;
  termBody.innerHTML = tab === 'history' ? renderHistory(ctx) : tab === 'stats' ? renderStats(ctx) : renderTrade(ctx);
  termBody.scrollTop = scroll;
  document.querySelectorAll<HTMLButtonElement>('#terminal-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
}

function refresh() {
  renderChart();
  renderQuotes();
  renderTerminal();
  save();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

function speedLabel(n: number) {
  if (n < 60) return `${n} 分 / 秒`;
  if (n < 1440) return `${n / 60} 時間 / 秒`;
  return `${n / 1440} 日 / 秒`;
}

// ---------------- 注文の画面 ----------------
const num = (el: HTMLInputElement) => (el.value.trim() === '' ? null : Number(el.value));

function openOrderDialog(type: 'market' | PendingType = 'market', price?: number) {
  const dlg = $<HTMLDialogElement>('#order-dialog');
  $('#od-symbol').textContent = md.symbol.toUpperCase();
  $('#od-bid').textContent = formatPrice(md.bid[cursor].c, md.digits);
  $('#od-ask').textContent = formatPrice(md.ask[cursor].c, md.digits);
  $<HTMLSelectElement>('#od-type').value = type;
  $<HTMLInputElement>('#od-lots').value = String(state.lots);
  $<HTMLInputElement>('#od-price').value = price !== undefined ? formatPrice(price, md.digits) : formatPrice(md.bid[cursor].c, md.digits);
  $<HTMLInputElement>('#od-sl').value = '';
  $<HTMLInputElement>('#od-tp').value = '';
  $('#od-error').textContent = '';
  for (const id of ['#od-price', '#od-sl', '#od-tp']) $<HTMLInputElement>(id).step = String(10 ** -md.digits);
  syncOrderType();
  dlg.showModal();
}

function syncOrderType() {
  const market = $<HTMLSelectElement>('#od-type').value === 'market';
  $('#od-price-row').hidden = market;
  $('#od-market-buttons').hidden = !market;
  $('#od-place').hidden = market;
  $('#od-hint').textContent = `スプレッド ${((md.ask[cursor].c - md.bid[cursor].c) / spec.pip).toFixed(1)} pips。S/L・T/P は価格で入力します（空欄はなし）。`;
}

$('#od-type').addEventListener('change', syncOrderType);

function submitOrder(side: 'buy' | 'sell' | null) {
  const lots = Number($<HTMLInputElement>('#od-lots').value);
  const sl = num($<HTMLInputElement>('#od-sl'));
  const tp = num($<HTMLInputElement>('#od-tp'));
  const action: NewAction =
    side !== null
      ? { kind: 'market', side, lots, sl, tp }
      : { kind: 'pending', type: $<HTMLSelectElement>('#od-type').value as PendingType, price: Number($<HTMLInputElement>('#od-price').value), lots, sl, tp };
  const err = account.apply(feed, cursor, { ...action, t: md.bid[cursor].t } as Action);
  if (err) {
    $('#od-error').textContent = err;
    return;
  }
  test().actions.push({ ...action, t: md.bid[cursor].t } as Action);
  state.lots = lots;
  lotsEl.value = String(lots);
  $<HTMLDialogElement>('#order-dialog').close();
  refresh();
}

$('#od-buy').addEventListener('click', () => submitOrder('buy'));
$('#od-sell').addEventListener('click', () => submitOrder('sell'));
$('#od-place').addEventListener('click', () => submitOrder(null));

let modifyTicket = 0;
function openModifyDialog(ticket: number) {
  const p = account.positions.find((x) => x.ticket === ticket);
  const o = account.orders.find((x) => x.ticket === ticket);
  if (!p && !o) return;
  modifyTicket = ticket;
  const f = (v: number | null) => (v === null ? '' : formatPrice(v, md.digits));
  $('#md-title').textContent = p ? `#${p.ticket} ${p.side} ${p.lots.toFixed(2)} ${p.symbol}` : `#${o!.ticket} ${o!.type} ${o!.lots.toFixed(2)} ${o!.symbol}`;
  $('#md-price-row').hidden = !o;
  $('#md-lots-row').hidden = !p;
  $('#md-close').hidden = !p;
  $('#md-delete').hidden = !o;
  $<HTMLInputElement>('#md-price').value = o ? f(o.price) : '';
  $<HTMLInputElement>('#md-sl').value = f((p ?? o)!.sl);
  $<HTMLInputElement>('#md-tp').value = f((p ?? o)!.tp);
  $<HTMLInputElement>('#md-lots').value = p ? p.lots.toFixed(2) : '';
  $('#md-error').textContent = '';
  for (const id of ['#md-price', '#md-sl', '#md-tp']) $<HTMLInputElement>(id).step = String(10 ** -md.digits);
  $<HTMLDialogElement>('#modify-dialog').showModal();
}

function modifyAction(kind: 'modify' | 'close' | 'cancel') {
  let a: NewAction;
  if (kind === 'modify') {
    const price = num($<HTMLInputElement>('#md-price'));
    a = { kind, ticket: modifyTicket, sl: num($<HTMLInputElement>('#md-sl')), tp: num($<HTMLInputElement>('#md-tp')), ...(price !== null ? { price } : {}) };
  } else if (kind === 'close') a = { kind, ticket: modifyTicket, lots: Number($<HTMLInputElement>('#md-lots').value) };
  else a = { kind, ticket: modifyTicket };
  const action = { ...a, t: md.bid[cursor].t } as Action;
  const err = account.apply(feed, cursor, action);
  if (err) {
    $('#md-error').textContent = err;
    return;
  }
  test().actions.push(action);
  $<HTMLDialogElement>('#modify-dialog').close();
  refresh();
}

$('#md-apply').addEventListener('click', () => modifyAction('modify'));
$('#md-close').addEventListener('click', () => modifyAction('close'));
$('#md-delete').addEventListener('click', () => modifyAction('cancel'));

overlay.onEdit = (e: LineEdit) => {
  const p = account.positions.find((x) => x.ticket === e.ticket);
  const o = account.orders.find((x) => x.ticket === e.ticket);
  const cur = p ?? o;
  if (!cur) return;
  if (e.field === 'price') act({ kind: 'modify', ticket: e.ticket, sl: cur.sl, tp: cur.tp, price: e.price });
  else act({ kind: 'modify', ticket: e.ticket, sl: e.field === 'sl' ? e.price : cur.sl, tp: e.field === 'tp' ? e.price : cur.tp });
  // 失敗したときも線を元の位置に戻す
  renderQuotes();
};

// ---------------- 新しい検証 ----------------
function openNewTestDialog() {
  const sel = $<HTMLSelectElement>('#nt-symbol');
  sel.innerHTML = symbolEl.innerHTML;
  sel.value = md.symbol;
  sel.disabled = !manifest;
  $<HTMLInputElement>('#nt-start').value = toLocalInput(md.bid[cursor].t, state.zone, rule);
  $<HTMLInputElement>('#nt-balance').value = String(state.test?.initialBalance ?? DEFAULT_BALANCE);
  $<HTMLInputElement>('#nt-leverage').value = String(state.test?.leverage ?? DEFAULT_LEVERAGE);
  $('#nt-error').textContent = '';
  $<HTMLDialogElement>('#newtest-dialog').showModal();
}

async function startTest(symbol: string, start: number, balance: number, leverage: number): Promise<string | null> {
  setPlaying(false);
  if (symbol !== md?.symbol || md.indexAtOrBefore(start) < 0 || start > md.bid[md.bid.length - 1].t || start < md.bid[0].t) {
    await openSymbol(symbol, start);
  }
  const idx = md.indexAtOrBefore(start);
  if (idx < 0) return 'その日時より前のデータがありません';
  state.symbol = md.symbol;
  symbolEl.value = md.symbol;
  const t = md.bid[idx].t;
  state.cursor = t;
  cursor = idx;
  state.test = {
    startTime: t,
    initialBalance: balance,
    leverage,
    baseline: { time: t, balance, history: [{ kind: 'balance', ticket: 1, time: t, amount: balance, comment: 'Deposit' }], nextTicket: 2 },
    actions: [],
  };
  rebuildAccount();
  renderChart(true);
  chart.timeScale().scrollToRealTime();
  refresh();
  save(true);
  return null;
}

$('#nt-start-btn').addEventListener('click', async () => {
  const start = fromLocalInput($<HTMLInputElement>('#nt-start').value, state.zone, rule);
  const balance = Number($<HTMLInputElement>('#nt-balance').value);
  const leverage = Number($<HTMLInputElement>('#nt-leverage').value);
  if (!Number.isFinite(start)) return void ($('#nt-error').textContent = '開始日時を入力してください');
  if (!(balance > 0) || !(leverage >= 1)) return void ($('#nt-error').textContent = '初期資金とレバレッジを確認してください');
  const err = await startTest($<HTMLSelectElement>('#nt-symbol').value, start, balance, leverage);
  if (err) $('#nt-error').textContent = err;
  else $<HTMLDialogElement>('#newtest-dialog').close();
});

// ---------------- 操作 ----------------
async function changeSymbol(symbol: string) {
  if (account.positions.length || account.orders.length) {
    toast('ポジションと待機注文をすべて閉じてから銘柄を切り替えてください');
    symbolEl.value = md.symbol;
    return;
  }
  setPlaying(false);
  // 今の口座を出発点にして、新しい銘柄で続ける
  test().baseline = { time: state.cursor, balance: account.balance, history: account.history.slice(), nextTicket: account.nextTicket };
  test().actions = [];
  state.symbol = symbol;
  await openSymbol(symbol, state.cursor);
  test().baseline.time = md.bid[cursor].t;
  rebuildAccount();
  renderChart(true);
  chart.timeScale().scrollToRealTime();
  refresh();
}

function setTf(tf: Timeframe) {
  state.tf = tf;
  document.querySelectorAll<HTMLButtonElement>('[data-tf]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tf === tf)));
  renderChart(true);
  chart.timeScale().scrollToRealTime();
  renderQuotes();
  save();
}

function setupControls() {
  const tfBar = $('#timeframes');
  for (const name of Object.keys(TIMEFRAMES) as Timeframe[]) {
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.dataset.tf = name;
    btn.addEventListener('click', () => setTf(name));
    tfBar.append(btn);
  }

  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
    b.addEventListener('click', () => drawings.setTool((b.dataset.tool || null) as DrawingKind | null)),
  );
  drawings.onToolChange = (tool) =>
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.tool || null) === tool)));
  drawings.onToolChange(null);
  drawings.onChange = () => {
    state.drawings[md.symbol] = drawings.drawings;
    save();
  };
  $('#clear-drawings').addEventListener('click', () => {
    if (drawings.drawings.length && confirm(`${md.symbol.toUpperCase()} の図形をすべて消しますか？`)) drawings.clearAll();
  });

  const zoom = (f: number) => {
    const ts = chart.timeScale();
    ts.applyOptions({ barSpacing: Math.max(1, Math.min(60, ts.options().barSpacing * f)) });
  };
  $('#zoom-in').addEventListener('click', () => zoom(1.25));
  $('#zoom-out').addEventListener('click', () => zoom(0.8));
  $('#toggle-history').addEventListener('click', (e) => {
    overlay.showHistory = !overlay.showHistory;
    (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(overlay.showHistory));
    renderQuotes();
  });

  const zoneEl = $<HTMLSelectElement>('#zone');
  zoneEl.addEventListener('change', () => {
    state.zone = zoneEl.value as DisplayZone;
    dataChanged();
    renderChart(true, false);
    chart.timeScale().scrollToRealTime();
    refresh();
  });

  symbolEl.addEventListener('change', () => changeSymbol(symbolEl.value));
  $('#new-order').addEventListener('click', () => openOrderDialog());
  $('#new-test').addEventListener('click', openNewTestDialog);

  $('#sell-btn').addEventListener('click', () => act({ kind: 'market', side: 'sell', lots: state.lots, sl: null, tp: null }));
  $('#buy-btn').addEventListener('click', () => act({ kind: 'market', side: 'buy', lots: state.lots, sl: null, tp: null }));
  lotsEl.addEventListener('change', () => {
    const v = Math.round(Number(lotsEl.value) * 100) / 100;
    if (v > 0) state.lots = v;
    lotsEl.value = String(state.lots);
    save();
  });

  playBtn.addEventListener('click', () => setPlaying(!playing));
  $('#fwd-bar').addEventListener('click', (e) => (e.shiftKey ? goTo(cursor + 1) : stepBar(1)));
  $('#back-bar').addEventListener('click', (e) => (e.shiftKey ? goTo(cursor - 1) : stepBar(-1)));
  speedEl.addEventListener('input', () => {
    state.speed = Number(speedEl.value);
    $('#speed-label').textContent = speedLabel(SPEEDS[state.speed]);
    save();
  });
  $<HTMLInputElement>('#pause-on-fill').addEventListener('change', (e) => {
    state.pauseOnFill = (e.target as HTMLInputElement).checked;
    save();
  });
  $('#jump-btn').addEventListener('click', jump);
  $('#jump').addEventListener('keydown', (e) => e.key === 'Enter' && jump());

  document.querySelectorAll<HTMLButtonElement>('#terminal-tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      state.terminalTab = b.dataset.tab!;
      renderTerminal(true);
      save();
    }),
  );
  termBody.addEventListener('dblclick', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-ticket]');
    if (row && row.dataset.kind !== 'history') openModifyDialog(Number(row.dataset.ticket));
  });
  termBody.addEventListener('contextmenu', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-ticket]');
    if (!row || row.dataset.kind === 'history') return;
    e.preventDefault();
    const ticket = Number(row.dataset.ticket);
    const items: [string, () => void][] =
      row.dataset.kind === 'position'
        ? [
            ['決済', () => act({ kind: 'close', ticket })],
            ['注文変更', () => openModifyDialog(ticket)],
          ]
        : [
            ['注文変更', () => openModifyDialog(ticket)],
            ['注文削除', () => act({ kind: 'cancel', ticket })],
          ];
    items.push(['新規注文', () => openOrderDialog()]);
    showMenu(e.clientX, e.clientY, items);
  });
  document.addEventListener('mousedown', (e) => {
    if (!ctxMenu.contains(e.target as Node)) ctxMenu.hidden = true;
  });

  // ターミナルの高さ
  const term = $('#terminal');
  term.style.height = `${state.terminalHeight}px`;
  $('#splitter').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      state.terminalHeight = Math.max(60, Math.min(window.innerHeight - 200, window.innerHeight - ev.clientY - 5));
      term.style.height = `${state.terminalHeight}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      save();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', () => save(true));
}

function showMenu(x: number, y: number, items: [string, () => void][]) {
  ctxMenu.innerHTML = '';
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => {
      ctxMenu.hidden = true;
      fn();
    });
    ctxMenu.append(b);
  }
  ctxMenu.style.left = `${x}px`;
  ctxMenu.style.top = `${y}px`;
  ctxMenu.hidden = false;
}

async function jump() {
  const t = fromLocalInput($<HTMLInputElement>('#jump').value, state.zone, rule);
  if (!Number.isFinite(t)) return toast('日時を入力してください');
  if (t < test().baseline.time) toast('検証を始めた時刻より前には戻れません（新しい検証で始め直せます）');
  setPlaying(false);
  // 先の日時なら、そこまでのデータを読み込む（途中の約定も計算するため、間の月もすべて）
  if (t > md.bid[md.bid.length - 1].t && md.hasLater) {
    const key = new Date(t).toISOString().slice(0, 7);
    const to = md.months.findLastIndex((m) => m <= key);
    const from = md.months.indexOf(md.loadedMonths[0]);
    await md.loadRange(from, Math.max(to, from));
    await syncUsd();
    dataChanged();
  }
  goTo(md.indexAtOrBefore(t));
  chart.timeScale().scrollToRealTime();
}

function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || document.querySelector('dialog[open]')) return;
  switch (e.key) {
    case ' ':
      setPlaying(!playing);
      break;
    case 'ArrowRight':
      if (e.shiftKey) goTo(cursor + 1);
      else stepBar(1);
      break;
    case 'ArrowLeft':
      if (e.shiftKey) goTo(cursor - 1);
      else stepBar(-1);
      break;
    case 'F9':
      openOrderDialog();
      break;
    case 'Delete':
    case 'Backspace':
      if (!drawings.deleteSelected()) return;
      break;
    case 'Escape':
      drawings.setTool(null);
      ctxMenu.hidden = true;
      return;
    default:
      return;
  }
  e.preventDefault();
}

// ---------------- 起動 ----------------
async function start() {
  state = { ...defaultState(), ...loadState() };
  manifest = await loadManifest();
  const symbols = manifest ? Object.keys(manifest.symbols).filter((s) => manifest!.symbols[s].months.length) : [];
  if (!manifest || symbols.length === 0) {
    manifest = null;
    symbolEl.hidden = true;
  }
  for (const s of symbols) symbolEl.add(new Option(s.toUpperCase(), s));
  if (manifest && !symbols.includes(state.symbol)) {
    state.symbol = symbols.includes('usdjpy') ? 'usdjpy' : symbols[0];
    state.test = null;
  }
  symbolEl.value = state.symbol;

  // 前回の続きなら、口座の計算に必要な所（検証の出発点）から読み込む
  const resume = state.test && state.cursor ? state.cursor : null;
  await openSymbol(state.symbol, resume);
  if (resume && state.test && md.indexAtOrBefore(state.test.baseline.time) < 0) {
    const key = new Date(state.test.baseline.time).toISOString().slice(0, 7);
    const from = Math.max(0, md.months.findIndex((m) => m >= key));
    await md.loadRange(from, md.months.indexOf(md.loadedMonths[md.loadedMonths.length - 1]));
    await syncUsd();
    dataChanged();
  }

  setupControls();
  $<HTMLSelectElement>('#zone').value = state.zone;
  speedEl.value = String(state.speed);
  $('#speed-label').textContent = speedLabel(SPEEDS[state.speed]);
  $<HTMLInputElement>('#pause-on-fill').checked = state.pauseOnFill;
  lotsEl.value = String(state.lots);
  document.querySelectorAll<HTMLButtonElement>('[data-tf]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tf === state.tf)));

  if (!state.test || md.indexAtOrBefore(state.cursor) < 0) {
    // 初めて開いたとき: データの最後から 5 日前を開始時刻にする
    const startAt = md.bid[Math.max(0, md.bid.length - 1 - 5 * DAY_BARS)].t;
    await startTest(md.symbol, startAt, DEFAULT_BALANCE, DEFAULT_LEVERAGE);
  } else {
    cursor = md.indexAtOrBefore(state.cursor);
    rebuildAccount();
    renderChart(true);
    refresh();
  }
  $<HTMLInputElement>('#jump').value = toLocalInput(md.bid[cursor].t, state.zone, rule);

  const ms = Math.round(performance.now());
  statusEl.textContent = `${manifest ? md.symbol.toUpperCase() : '仮データ'} ${md.loadedMonths.join('〜').replace(/〜.*〜/, '〜') || ''} / 表示まで ${ms} ms`;
  if (!manifest) statusEl.textContent += '（npm run import-data で実データを入れてください）';
}

start().catch((e) => {
  console.error(e);
  statusEl.textContent = `エラー: ${e instanceof Error ? e.message : e}`;
});
