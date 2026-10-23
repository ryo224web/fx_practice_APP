import { type CandlestickData, type Time, type UTCTimestamp } from 'lightweight-charts';
import { commandIndex, KEY_COMMANDS, keyLabel, keyOf, resolveKeymap } from './ui/keys';
import { DEFAULT_TF_COLORS, FIBO_EXP_LEVELS, FIBO_LEVELS, levelsFromPercents, type DrawingKind } from './chart/drawings';
import { DEFAULT_INDICATORS, normalizeIndicators, type IndicatorConfig } from './chart/indicators';
import { ChartPane, type PaneHost } from './chart/pane';
import { type LineEdit, type OrderPreview } from './chart/trades';
import { aggregateWithIndex, mergeBars, TIMEFRAMES, type Aggregated, type Bar, type Timeframe } from './core/candles';
import { formatMoney, formatPrice, formatTime, fromLocalInput, toLocalInput } from './core/format';
import { sampleM1 } from './core/sample';
import { DEFAULT_SPREAD_PIPS, symbolSpec, type SymbolSpec } from './core/symbols';
import { DEFAULT_SERVER_RULE, serverToUtc, toDisplay, type DisplayZone } from './core/time';
import { loadManifest, loadMonths, type Manifest } from './data/store';
import { buildMt4Account } from './mt4/account';
import { applyTemplate, deleteTemplate, loadTemplates, pickTemplate, saveTemplate, setDefaultTemplate, type ChartTemplate } from './templates';
import { detectOffsetHours, matchTrade, parseHistoryFile, type Mt4Trade, type PriceLookup } from './mt4/history';
import { MarketData } from './replay/market';
import {
  createProject,
  currentMeta,
  deleteProject,
  exportProject,
  flushSave,
  importProject,
  initStore,
  listProjects,
  loadState,
  renameProject,
  setProjectFolder,
  createFolder,
  renameFolder,
  deleteFolder,
  listFolders,
  saveState,
  storeInfo,
  switchProject,
  type AppState,
  type ProjectMeta,
  type EasyOrderState,
  type Layout,
  type PaneState,
  type TestState,
} from './state';
import { Account, type Action, type FillEvent, type NewAction, type PendingType, type PriceFeed, type Side } from './trade/account';
import { checkpointAtOrBefore, ledgerMatches, restoreAccount, Runner } from './trade/ledger';
import { lossAt, lotsForRisk } from './trade/risk';
import { analyze, excursionOf, tradesCsv, type Analysis, type TradeRecord } from './trade/analysis';
import { renderHistory, renderMt4, renderTrade, type Mt4Row, type TerminalTab } from './ui/terminal';
import { quickSummary, REPORT_CSS, reportBody, reportHtml } from './ui/report';
import './style.css';

// 成績レポートの見た目（書き出すファイルと同じものを画面にも使う）
document.head.append(Object.assign(document.createElement('style'), { textContent: REPORT_CSS }));

const rule = DEFAULT_SERVER_RULE;
/** 再生速度（1 秒に進む 1 分足の本数） */
const SPEEDS = [1, 2, 5, 15, 30, 60, 240, 720, 1440];
const DEFAULT_BALANCE = 1_000_000;
const DEFAULT_LEVERAGE = 500;
const DAY_BARS = 1440;

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const statusEl = $('#status');
const symbolEl = $<HTMLSelectElement>('#symbol');
const clockEl = $('#clock');
const playBtn = $<HTMLButtonElement>('#play');
const speedEl = $<HTMLInputElement>('#speed');
const lotsEl = $<HTMLInputElement>('#lots');
const termBody = $('#terminal-body');
const ctxMenu = $('#ctx-menu');

// ---------------- チャート（画面を分けて最大 4 枚） ----------------
const chartsEl = $('#charts');
let panes: ChartPane[] = [];
let active: ChartPane;
/** マウスが乗っているチャート（連動のときは、このチャートの動きにほかを合わせる） */
let leader: ChartPane | null = null;
/** 十字線を出しているか（真ん中のボタンで切り替える。全部のチャートで同じ） */
let crosshairOn = false;

function setCrosshair(on: boolean) {
  crosshairOn = on;
  for (const p of panes) p.setCrosshair(on);
}

/** 表示しているチャート */
function visiblePanes(): ChartPane[] {
  return panes.filter((p) => !p.el.hidden);
}

const LAYOUT_PANES: Record<Layout, number> = { '1': 1, '2h': 2, '2v': 2, '4': 4 };
const DEFAULT_PANE_TFS: Timeframe[] = ['M15', 'H4', 'H1', 'M5'];

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
const aggCache = new Map<
  Timeframe,
  { agg: Aggregated; times: number[]; closes: Float64Array; chartTimes: Time[]; version: number }
>();
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
  // その時点の USDJPY が無い（3 日以上前の値しか無い）ときは、古い値で換算しない
  if (j < 0 || md.bid[i].t - usd.bid[j].t > 3 * 86_400_000) return NaN;
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
    layout: '1',
    panes: DEFAULT_PANE_TFS.map((tf) => ({ tf })),
    indicatorSets: Object.fromEntries(Object.keys(TIMEFRAMES).map((tf) => [tf, structuredClone(DEFAULT_INDICATORS)])),
    activePane: 0,
    easyOrder: DEFAULT_EO,
    mt4: null,
  };
}

const DEFAULT_EO: EasyOrderState = { open: false, mode: 'market', risk: 1, riskUnit: 'pct', entry: null, sl: null, tp: null };

/**
 * 以前の保存を今の形に移す。
 * - チャート 1 枚 → チャート 4 枚分の設定
 * - チャートごとのインジケーター → 時間足ごとのインジケーター（そのチャートの時間足の設定にする。無い時間足は 1 枚目の設定）
 */
function migratePanes() {
  if (state.panes?.length !== 4) {
    state.panes = DEFAULT_PANE_TFS.map((tf, i) => ({ tf: i === 0 ? state.tf : tf, indicators: i === 0 ? state.indicators : undefined }));
    state.layout ??= '1';
    state.activePane = 0;
  }
  if (!state.indicatorSets) {
    const sets: Record<string, IndicatorConfig> = {};
    for (const ps of state.panes) if (ps.indicators && !sets[ps.tf]) sets[ps.tf] = ps.indicators;
    const base = state.panes[0].indicators ?? state.indicators ?? DEFAULT_INDICATORS;
    for (const tf of Object.keys(TIMEFRAMES)) sets[tf] ??= structuredClone(base);
    state.indicatorSets = sets;
  }
  for (const ps of state.panes) delete ps.indicators;
}

/** その時間足のインジケーターの設定 */
function indicatorsFor(tf: Timeframe): IndicatorConfig {
  const sets = (state.indicatorSets ??= {});
  return (sets[tf] = normalizeIndicators(sets[tf] ?? structuredClone(DEFAULT_INDICATORS)));
}

/** 起動時用: 並べ方を反映する（描画はこの後でまとめて行う） */
function setLayoutQuiet(layout: Layout) {
  state.layout = layout;
  chartsEl.className = `layout-${layout}`;
  const n = LAYOUT_PANES[layout];
  panes.forEach((p, i) => (p.el.hidden = i >= n));
  if (active.el.hidden) active = panes[0];
  for (const x of panes) x.setActive(x === active && n > 1);
  $<HTMLSelectElement>('#layout').value = layout;
  syncTfButtons();
}

function eo(): EasyOrderState {
  return (state.easyOrder ??= { ...DEFAULT_EO });
}

function save(now = false) {
  // 計算結果（月ごとの区切り）も残す。開き直したときに、検証の最初から計算し直さなくて済む
  if (state.test && runner) state.test.ledger = runner.ledger(state.test.baseline.time);
  // プロジェクトを切り替えて読み直す間は書かない（切り替え先を上書きしないように）
  if (!leaving) saveState(state, now);
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
  applySpread();
  const list = (state.drawings[md.symbol] ??= []);
  for (const p of panes) {
    p.setDigits(md.digits);
    p.drawings.setDrawings(list);
  }
  // 読み込み済みの MT4 履歴に、この銘柄の取引があれば時刻のずれを判定する（まだなら）
  if (state.mt4) await detectMt4ForSymbol();
}

/**
 * 今の検証のスプレッドを価格データに入れる。固定スプレッドの検証なら Ask = Bid + スプレッド、
 * 固定スプレッドを決める前に始めた検証なら、データの Ask（欠けは推定）
 */
function applySpread() {
  const pips = state.test?.spreadPips?.[md.symbol];
  md.setFixedSpread(pips === undefined ? null : Number((pips * spec.pip).toFixed(md.digits + 1)));
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
  // 同じ月だけを持つ（長い検証で USDJPY のデータが増え続けないように）
  await usd.setWindow(from, to);
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
    const agg = withHistory(aggregateWithIndex(md.bid, tf, rule), tf);
    // チャート用の形（CandlestickData）は描く分だけその都度作る（全部の足の分を持つとメモリを食うため）
    c = {
      agg,
      times: agg.bars.map((b) => b.t),
      closes: Float64Array.from(agg.bars, (b) => b.c),
      chartTimes: agg.bars.map((b) => (toDisplay(b.t, state.zone, rule) / 1000) as UTCTimestamp),
      version: dataVersion,
    };
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


/** 仮想の取引をまだしていない（開始時刻を動かしてよい） */
function isPristine(): boolean {
  const t = test();
  return t.actions.length === 0 && t.baseline.history.every((h) => h.kind === 'balance');
}

// ---------------- 口座 ----------------
// 口座は Runner（src/trade/ledger.ts）が 1 分足を順に処理して作る。月の変わり目ごとに区切りを残すので、
// 巻き戻し・開き直しは手前の区切りから計算し直せる（10 年の検証でも速い）。

/** 読み込んでおく月の上限。長い検証でも、今の時刻の辺りだけを持つ（メモリが増えないように） */
const MAX_MONTHS = 30;

let runner: Runner | null = null;
/** 日時の移動・巻き戻しの計算中（その間は再生やキー操作を受け付けない） */
let traveling = false;

const settingsOf = () => ({ leverage: test().leverage });

/** 検証の出発点から口座を作り直す（出発点の足が読み込んである前提。新しい検証・銘柄の切り替えのとき） */
function freshRunner() {
  const t = test();
  runner = new Runner(new Account(spec, settingsOf(), t.baseline), t.actions.slice().sort((a, b) => a.t - b.t), [], true);
  t.actions = runner.actions;
  account = runner.account;
  const i = md.indexAtOrBefore(t.baseline.time);
  runner.run(feed, Math.max(0, i), cursor);
}

/**
 * 価格データを fromT〜toT（UTC）の月が入るように読み込む（1 か月先まで）。
 * 上限（MAX_MONTHS）を超えるときは、fromT から上限まで（続きは呼び出し側が順に読む）
 */
async function ensureWindow(fromT: number, toT: number, exact = false) {
  if (!manifest || !md.months.length) return;
  let lo = md.monthIndexOf(fromT);
  let hi = Math.min(md.months.length - 1, md.monthIndexOf(toT) + 1);
  if (hi - lo + 1 > MAX_MONTHS) hi = lo + MAX_MONTHS - 1;
  const [curLo, curHi] = md.windowRange;
  if (!exact && curLo >= 0 && lo >= curLo && hi <= curHi) return;
  if (exact && lo === curLo && hi === curHi) return;
  // 今の範囲とつなげて上限に収まるなら残す（戻ったときに読み直さなくて済む）。収まらなければ入れ替える。
  // exact のときは、ちょうどその範囲にする（長い移動の後に、要らない月を捨ててメモリを空ける）
  if (!exact && curLo >= 0 && Math.max(hi, curHi) - Math.min(lo, curLo) + 1 <= MAX_MONTHS) {
    lo = Math.min(lo, curLo);
    hi = Math.max(hi, curHi);
  }
  statusEl.textContent = `${md.symbol.toUpperCase()} ${md.months[lo]}〜${md.months[hi]} を読み込み中…`;
  await md.setWindow(lo, hi);
  await syncUsd();
  dataChanged();
}

/**
 * 時刻 time（UTC）の時点へ移る（日時への移動・巻き戻し・開き直し）。
 * - 戻るときは、time より後の操作を消し、手前の区切りから計算し直す
 * - 進むときは、途中の約定も計算する（価格データは上限ずつ読みながら進むので、何年先でもメモリは増えない）
 * keepView なら、見ている場所と拡大率を変えない（1 本戻るとき。日時への移動などは、移った時刻を右端に出す）
 */
async function travel(time: number, keepView = false) {
  if (traveling) return;
  traveling = true;
  setPlaying(false);
  try {
    const t = test();
    if (time < t.baseline.time) {
      if (!isPristine()) {
        toast('取引した後は、検証を始めた時刻より前には戻れません（新しい検証で始め直せます）');
        time = t.baseline.time;
      } else {
        // まだ何も取引していなければ、検証の開始時刻ごと前へずらす
        await ensureWindow(time - 31 * 86_400_000, time);
        const i = Math.max(0, md.indexAtOrBefore(time));
        t.baseline.time = t.startTime = md.bid[i].t;
        for (const h of t.baseline.history) if (h.kind === 'balance') h.time = t.startTime;
        state.cursor = t.baseline.time;
        cursor = i;
        freshRunner();
        afterTravel(keepView);
        return;
      }
    }
    if (!runner || time < runner.account.time) {
      // 手前の区切り（無ければ検証の出発点）から作り直す。区切りは、計算中ならその結果、開き直しなら保存したもの
      const saved = ledgerMatches(t.ledger, t.baseline.time, t.actions) ? t.ledger : null;
      const cps = runner ? runner.checkpoints : (saved?.checkpoints ?? []);
      const history = runner ? runner.account.history : (saved?.history ?? []);
      const cp = checkpointAtOrBefore(cps, time);
      const usable = cp && cp.time >= t.baseline.time ? cp : null;
      const actions = t.actions.filter((a) => a.t <= time).sort((a, b) => a.t - b.t);
      runner = new Runner(
        restoreAccount(spec, settingsOf(), t.baseline, history, usable),
        actions,
        cps.filter((c) => usable && c.time <= usable.time),
        !usable,
      );
      t.actions = runner.actions;
      account = runner.account;
    }
    // 価格データを（上限の月数ずつ）読みながら time まで進める
    for (let stuck = 0; ; ) {
      await ensureWindow(runner.account.time, time);
      const before = runner.account.time;
      const to = md.indexAtOrBefore(time);
      if (to >= 0) runner.run(feed, Math.max(0, md.indexAtOrBefore(runner.account.time)), to);
      if (md.bid[md.bid.length - 1].t >= time || !md.hasLater) break;
      // 進まないとき（データの抜けなど）に止まらなくならないように
      if (runner.account.time === before && ++stuck > 2) break;
      statusEl.textContent = `計算中… ${new Date(runner.account.time).toISOString().slice(0, 7)}`;
    }
    // 表示用に、今の時刻の辺り（2 か月前〜1 か月先）だけにする。インジケーターに要る分は後で足す
    await ensureWindow(time - 62 * 86_400_000, time, true);
    cursor = Math.max(0, md.indexAtOrBefore(Math.min(time, runner.account.time)));
    state.cursor = md.bid[cursor].t;
    afterTravel(keepView);
  } finally {
    traveling = false;
  }
}

function afterTravel(keepView = false) {
  // 見ている場所を保つときは、右端の時刻と足の幅で戻す（最新を見ていれば、戻した後の最新）
  renderChart(true, keepView);
  if (!keepView) scrollToNow();
  refresh();
  updateStatus();
  void ensureIndicatorHistory();
}

/** 今の足で操作する（操作の記録に残す） */
function record(action: Action) {
  runner!.record(action);
  test().actions = runner!.actions;
}

function act(a: NewAction): boolean {
  if (mt4Mode()) {
    toast('この検証の口座は MT4 の取引です（自分では注文できません。練習するときは別のプロジェクトで「新しい検証」を始めてください）');
    return false;
  }
  const action = { ...a, t: md.bid[cursor].t } as Action;
  const err = account.apply(feed, cursor, action);
  if (err) {
    toast(err);
    return false;
  }
  record(action);
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
/** target 番目の 1 分足まで動く。約定で止まったら true。pause=false なら途中の約定で止まらない（日時への移動など） */
function goTo(target: number, pause = true): boolean {
  if (traveling || !runner) return false;
  if (target < cursor) {
    // 戻るときは、手前の区切りから計算し直す（データの読み込みが要ることもあるので非同期）
    const i = Math.max(0, target);
    // 1 本・1 分戻るときは、拡大率も見ている場所もそのまま（進むときと同じ）
    void travel(target < 0 ? md.bid[0].t - 60_000 : md.bid[i].t, true);
    return false;
  }
  target = Math.min(md.bid.length - 1, target);
  let stopped = false;
  if (target > cursor) {
    // 約定・決済や、MT4 の記録のエントリー・決済があった足で止める（「約定したら一時停止」のとき）
    cursor = runner.run(feed, cursor + 1, target, (ev, i) => {
      if (!pause) return false;
      const mt4 = mt4EventsIn(md.bid[i].t);
      if (ev.length) notifyFills(ev);
      if (mt4.length) toast(mt4.join(' / '));
      const hit = (ev.length > 0 || mt4.length > 0) && state.pauseOnFill;
      if (hit) stopped = true;
      return hit;
    });
  }
  state.cursor = md.bid[cursor].t;
  refresh();
  maybeLoadLater();
  return stopped;
}

/** 今の時間足で 1 本進む（作りかけの足なら、その足の終わりまで） */
function stepBar(dir: 1 | -1) {
  const { agg } = getAgg(active.tf);
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
    save(true);
  }
}

function maybeLoadLater() {
  if (loadingLater || !md.hasLater || cursor < md.bid.length - 3 * DAY_BARS) return;
  loadingLater = true;
  const mdNow = md;
  md.loadLater(1)
    // 上限を超えたら、古い月を捨てる（長い検証でもメモリが増えないように）
    .then(() => {
      const [lo, hi] = md.windowRange;
      if (hi - lo + 1 > MAX_MONTHS) return md.setWindow(hi - MAX_MONTHS + 1, hi);
    })
    .then(syncUsd)
    .then(() => {
      if (md !== mdNow) return;
      dataChanged();
      renderChart(true, true);
    })
    .finally(() => (loadingLater = false));
}

let warnedWindow = false;
function loadEarlier(pane?: ChartPane) {
  if (loadingEarlier || !md.hasEarlier) return;
  // H1 以上のチャートは、1 時間足でさらに前を足す（1 分足の 30 か月の上限は関係ない）
  if (pane && TIMEFRAMES[pane.tf] >= 60) {
    loadingEarlier = true;
    const mdNow = md;
    const oldest = hourlyBefore()[0]?.t ?? md.bid[0].t;
    loadHourly(oldest - 365 * 86_400_000)
      .then((added) => {
        if (!added || md !== mdNow) return;
        dataChanged();
        renderChart(true, true);
      })
      .finally(() => (loadingEarlier = false));
    return;
  }
  const room = MAX_MONTHS - md.windowMonths;
  if (room <= 0) {
    if (!warnedWindow) toast(`H1 より短い時間足で読み込めるのは ${MAX_MONTHS} か月分までです。もっと前は H1 以上の時間足で見るか、「移動」で日時を選んでください`);
    warnedWindow = true;
    return;
  }
  loadingEarlier = true;
  const mdNow = md;
  md.loadEarlier(Math.min(3, room))
    .then(syncUsd)
    .then(() => {
      if (md !== mdNow) return;
      dataChanged();
      renderChart(true, true);
    })
    .finally(() => (loadingEarlier = false));
}

// ---------------- 表示 ----------------
function renderChart(reset = false, keepView = false) {
  for (const p of visiblePanes()) p.render(reset, keepView);
}

function scrollToNow() {
  for (const p of visiblePanes()) p.scrollToNow();
}

function renderQuotes() {
  const bid = md.bid[cursor].c;
  const ask = md.ask[cursor].c;
  const est = md.askEstimated[cursor] === 1;
  $('#bid-big').textContent = formatPrice(bid, md.digits);
  $('#ask-big').textContent = formatPrice(ask, md.digits);
  $('#spread').textContent = `${((ask - bid) / spec.pip).toFixed(1)} pips${md.spreadIsFixed ? '（固定）' : est ? '（推定）' : ''}`;
  $('#spread').title = md.spreadIsFixed
    ? 'この検証は固定スプレッドです（新しい検証を始めるときに決めます）'
    : est
      ? 'この時間の Ask はデータに無いため、直前のスプレッドで推定しています'
      : '';
  clockEl.textContent = formatTime(md.bid[cursor].t + 60_000, state.zone, rule);
  const view = {
    positions: account.positions,
    orders: account.orders,
    history: account.history,
    ask,
    askEstimated: est,
    digits: md.digits,
    preview: eoPreview(),
    imported: mt4View(),
  };
  for (const p of visiblePanes()) p.overlay.update(view);
  eoRender();
}

// ---------------- MT4 の取引を口座にする（「新しい検証」で選ぶ） ----------------
// 読み込んだ MT4 履歴の取引を、リプレイの時刻に合わせて口座に入れる。記録の時刻に建ち、記録の時刻・価格・損益で決済する
// （計算し直さない。R2）。保有中の含み損益だけはチャートの価格で計算する。

/** この検証の口座が MT4 の取引か（MT4 履歴はあとから読み込んでもよい。読み込むまでは入金だけの口座） */
function mt4Mode(): boolean {
  return state.test?.source === 'mt4';
}

let mt4AccountCache: { key: string; account: Account } | null = null;

/** 今の時刻（cursor の足の終わり）までの MT4 の取引でできた口座 */
function mt4Account(): Account {
  const t = test();
  const now = md.bid[cursor].t + 60_000;
  const key = `${now}:${state.mt4?.fileName}:${state.mt4?.trades.length}:${mt4Offset().hours}:${md.symbol}:${t.startTime}:${t.initialBalance}`;
  if (mt4AccountCache?.key === key) return mt4AccountCache.account;
  const a = buildMt4Account(spec, account.settings, state.mt4?.trades ?? [], {
    start: t.startTime,
    balance: t.initialBalance,
    now,
    symbol: md.symbol,
    toUtc: mt4ToUtc,
    pipOf,
  });
  a.time = md.bid[cursor].t;
  mt4AccountCache = { key, account: a };
  return a;
}

/** ターミナル・成績に出す口座（MT4 の取引の検証なら、その口座） */
function shownAccount(): Account {
  return mt4Mode() ? mt4Account() : account;
}

function renderTerminal(force = false) {
  const now = performance.now();
  if (!force && playing && now - lastTerminalRender < 200) return;
  lastTerminalRender = now;
  const scroll = termBody.scrollTop;
  const ctx = { account: shownAccount(), readOnly: mt4Mode(), feed, index: cursor, digits: md.digits, time: (t: number) => formatTime(t, state.zone, rule) };
  const tab = state.terminalTab as TerminalTab;
  document.querySelectorAll<HTMLButtonElement>('#terminal-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
  if (tab === 'memo') {
    // 書いている途中で作り直すと入力が消えるので、一度だけ作る
    if (!termBody.querySelector('#memo')) {
      termBody.innerHTML = `<textarea id="memo" spellcheck="false" placeholder="このプロジェクトのメモ。何を検証しているか（手法・ルール・期間）、気づいたこと、次にやることなど。プロジェクトと一緒に保存されます"></textarea>`;
      const area = termBody.querySelector<HTMLTextAreaElement>('#memo')!;
      area.value = state.note ?? '';
      area.addEventListener('input', () => {
        state.note = area.value;
        renderProjectButton();
        save();
      });
    }
    return;
  }
  termBody.innerHTML =
    tab === 'history'
      ? renderHistory(ctx)
      : tab === 'stats'
        ? renderStatsTab()
        : tab === 'mt4'
          ? renderMt4(mt4Rows(), mt4Info(), md.digits, ctx.time)
          : renderTrade(ctx);
  termBody.scrollTop = scroll;
  document.querySelectorAll<HTMLButtonElement>('#terminal-tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
}

// ---------------- 成績 ----------------

/** 保有中に一番不利・有利だった値幅（pips）。今の銘柄で、その期間の価格データがあるときだけ */
function excursion(symbol: string, side: 'buy' | 'sell', openTime: number, closeTime: number, openPrice: number, closePrice: number) {
  if (symbol.toLowerCase() !== md.symbol) return { mae: null, mfe: null };
  const i0 = md.indexAtOrBefore(openTime);
  const i1 = md.indexAtOrBefore(closeTime);
  if (i0 < 0 || i1 < i0 || openTime - md.bid[i0].t > 60_000) return { mae: null, mfe: null };
  return excursionOf(md.bid, md.ask, i0, i1, side, openPrice, closePrice, spec.pip);
}

/** 銘柄ごとの 1 pip（口座履歴にほかの銘柄が混ざっていても pips を正しく出すため） */
function pipOf(symbol: string): number {
  const s = symbol.toLowerCase();
  const digits = manifest?.symbols[s]?.digits ?? (/jpy/i.test(s) || /xau/i.test(s) ? 3 : 5);
  return symbolSpec(s, digits).pip;
}

function statsRecords(source: 'virtual' | 'mt4'): TradeRecord[] {
  if (source === 'mt4') {
    return (state.mt4?.trades ?? [])
      .filter((t) => t.closeServer !== null && t.closePrice !== null)
      .map((t) => {
        const openTime = mt4ToUtc(t.openServer);
        const closeTime = mt4ToUtc(t.closeServer!);
        const dir = t.side === 'buy' ? 1 : -1;
        return {
          ticket: t.ticket,
          side: t.side,
          lots: t.lots,
          openTime,
          closeTime,
          openPrice: t.openPrice,
          closePrice: t.closePrice!,
          sl: t.sl,
          tp: t.tp,
          profit: t.profit + t.swap + t.commission,
          pips: ((t.closePrice! - t.openPrice) * dir) / pipOf(t.symbol),
          // MT4 の履歴には決済の理由が無いので、記録の価格が S/L・T/P と同じかで見分ける
          reason: t.sl !== null && Math.abs(t.closePrice! - t.sl) < pipOf(t.symbol) * 0.5 ? 'sl' : t.tp !== null && Math.abs(t.closePrice! - t.tp) < pipOf(t.symbol) * 0.5 ? 'tp' : 'manual',
          ...excursion(t.symbol, t.side, openTime, closeTime, t.openPrice, t.closePrice!),
        } satisfies TradeRecord;
      });
  }
  return shownAccount().history.flatMap((h) => {
    if (h.kind !== 'trade') return [];
    const dir = h.side === 'buy' ? 1 : -1;
    return [
      {
        ticket: h.ticket,
        side: h.side,
        lots: h.lots,
        openTime: h.openTime,
        closeTime: h.closeTime,
        openPrice: h.openPrice,
        closePrice: h.closePrice,
        sl: h.sl,
        tp: h.tp,
        profit: h.profit,
        pips: ((h.closePrice - h.openPrice) * dir) / pipOf(h.symbol),
        reason: h.reason,
        // 口座が保有中に記録した値（価格データを読み込んでいない昔の取引でも分かる）。以前の記録には無いので、そのときは価格データから求める
        ...(h.mae !== undefined && h.mfe !== undefined
          ? { mae: h.mae / pipOf(h.symbol), mfe: h.mfe / pipOf(h.symbol) }
          : excursion(h.symbol, h.side, h.openTime, h.closeTime, h.openPrice, h.closePrice)),
      } satisfies TradeRecord,
    ];
  });
}

let statsCache: { key: string; a: Analysis } | null = null;

function currentAnalysis(): { a: Analysis; source: 'virtual' | 'mt4'; initial: number } {
  const source = state.statsSource === 'mt4' && state.mt4 ? 'mt4' : 'virtual';
  const initial = source === 'virtual' ? test().initialBalance : 0;
  const key = `${source}:${mt4Mode()}:${shownAccount().history.length}:${state.mt4?.fileName}:${state.mt4?.trades.length}:${mt4Offset().hours}:${state.zone}:${dataVersion}:${md.symbol}`;
  if (statsCache?.key !== key) {
    statsCache = { key, a: analyze(statsRecords(source), initial, spec.pip, (t) => toDisplay(t, state.zone, rule)) };
  }
  return { a: statsCache.a, source, initial };
}

function statsInfo(source: 'virtual' | 'mt4') {
  return {
    sourceLabel: source === 'mt4' ? `MT4 の履歴（${state.mt4?.fileName ?? ''}）` : mt4Mode() ? `MT4 の取引（この検証の口座。${state.mt4?.fileName ?? ''}）` : '仮想の取引',
    symbolLabel: md.symbol.toUpperCase(),
    hasBalance: source === 'virtual',
  };
}

function renderStatsTab(): string {
  const { a, source, initial } = currentAnalysis();
  const btn = (src: string, label: string, disabled = false) =>
    `<button type="button" data-action="stats-src" data-src="${src}" aria-pressed="${source === src}" ${disabled ? 'disabled title="MT4 履歴タブで読み込むと選べます"' : ''}>${label}</button>`;
  const bar = `<div class="mt4-bar">${btn('virtual', mt4Mode() ? 'この検証の口座（MT4）' : '仮想の取引')}${btn('mt4', 'MT4 の履歴', !state.mt4)}
    <span class="sep"></span>
    <button type="button" data-action="export-csv" title="取引の一覧を CSV で保存（Excel で開ける）">CSV で書き出す</button>
    <button type="button" data-action="export-html" title="グラフ付きのレポートを 1 つの HTML ファイルで保存">レポートを書き出す</button>
    <span class="hint">MAE・MFE（含み損益の最大）は、今の銘柄で価格データがある取引だけ計算します</span></div>`;
  // 一番上は簡単な一覧。詳しい分析はその下（書き出したレポートと同じ内容）
  const detail = a.summary.trades ? `<h3 class="detail-head">詳しい分析</h3>${reportBody(a, statsInfo(source), initial)}` : reportBody(a, statsInfo(source), initial);
  return bar + (a.summary.trades ? quickSummary(a.summary, statsInfo(source)) : '') + detail;
}

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportStats(kind: 'csv' | 'html') {
  const { a, source, initial } = currentAnalysis();
  const info = statsInfo(source);
  const date = new Date().toISOString().slice(0, 10);
  const base = `成績_${currentMeta().name}_${source === 'mt4' ? 'MT4' : '仮想'}_${date}`.replace(/[\\/:*?"<>|]/g, '_');
  const time = (t: number) => formatTime(t, state.zone, rule);
  if (kind === 'csv') {
    download(`${base}.csv`, tradesCsv(a.trades, time, md.digits, spec.pip, (t) => toDisplay(t, state.zone, rule)), 'text/csv');
  } else {
    const zone = state.zone === 'jst' ? '日本時間' : 'サーバー時間';
    const subtitle = `${currentMeta().name} ・ ${info.sourceLabel} ・ ${a.summary.trades} 回 ・ 時刻は${zone} ・ ${date} 作成`;
    download(`${base}.html`, reportHtml(`成績レポート（${info.symbolLabel}）`, subtitle, reportBody(a, info, initial)), 'text/html');
  }
}

function mt4Info() {
  const m = state.mt4;
  if (!m) return null;
  const off = mt4Offset();
  return { fileName: m.fileName, offsetHours: off.hours, matched: off.matched, checked: off.checked, detected: off.detected, others: m.trades.length - mt4Trades().length };
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
  record({ ...action, t: md.bid[cursor].t } as Action);
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
  record(action);
  $<HTMLDialogElement>('#modify-dialog').close();
  refresh();
}

$('#md-apply').addEventListener('click', () => modifyAction('modify'));
$('#md-close').addEventListener('click', () => modifyAction('close'));
$('#md-delete').addEventListener('click', () => modifyAction('cancel'));

function onLineEdit(e: LineEdit) {
  const p = account.positions.find((x) => x.ticket === e.ticket);
  const o = account.orders.find((x) => x.ticket === e.ticket);
  const cur = p ?? o;
  if (!cur) return;
  if (e.field === 'price') act({ kind: 'modify', ticket: e.ticket, sl: cur.sl, tp: cur.tp, price: e.price });
  else act({ kind: 'modify', ticket: e.ticket, sl: e.field === 'sl' ? e.price : cur.sl, tp: e.field === 'tp' ? e.price : cur.tp });
  // 失敗したときも線を元の位置に戻す
  renderQuotes();
}

// ---------------- 新しい検証 ----------------
/** 新しい検証の画面に、選んだ銘柄のスプレッドを出す（今の検証の値、無ければ初期値） */
function fillSpreadInput() {
  const sym = $<HTMLSelectElement>('#nt-symbol').value || md.symbol;
  $('#nt-spread-symbol').textContent = sym.toUpperCase();
  $<HTMLInputElement>('#nt-spread').value = String(state.test?.spreadPips?.[sym] ?? DEFAULT_SPREAD_PIPS[sym] ?? 0.5);
}

function openNewTestDialog() {
  const sel = $<HTMLSelectElement>('#nt-symbol');
  sel.innerHTML = symbolEl.innerHTML;
  sel.value = md.symbol;
  sel.disabled = !manifest;
  sel.onchange = fillSpreadInput;
  fillSpreadInput();
  $<HTMLInputElement>('#nt-start').value = toLocalInput(md.bid[cursor].t, state.zone, rule);
  $<HTMLInputElement>('#nt-balance').value = String(state.test?.initialBalance ?? DEFAULT_BALANCE);
  $<HTMLInputElement>('#nt-leverage').value = String(state.test?.leverage ?? DEFAULT_LEVERAGE);
  const src = $<HTMLSelectElement>('#nt-source');
  src.value = state.test?.source === 'mt4' ? 'mt4' : 'virtual';
  const hint = () =>
    ($('#nt-source-hint').textContent =
      src.value !== 'mt4'
        ? ''
        : '記録の時刻にポジションが建ち、記録の価格・損益で決済されます。残高・口座履歴・成績は MT4 の取引だけになります。自分では注文できません' +
          (state.mt4 ? '' : '。MT4 履歴は、始めたあとに「MT4 履歴」タブで読み込んでも大丈夫です（開始日時より後に決済した取引が入ります）'));
  src.onchange = () => {
    hint();
    // MT4 の取引にしたら、開始日時をその銘柄の最初の取引の 1 日前にする
    if (src.value !== 'mt4') return;
    const sym = $<HTMLSelectElement>('#nt-symbol').value || md.symbol;
    const opens = (state.mt4?.trades ?? []).filter((x) => x.symbol.toLowerCase() === sym).map((x) => mt4ToUtc(x.openServer));
    if (opens.length) $<HTMLInputElement>('#nt-start').value = toLocalInput(Math.min(...opens) - 86_400_000, state.zone, rule);
  };
  hint();
  $('#nt-error').textContent = '';
  $<HTMLDialogElement>('#newtest-dialog').showModal();
}

async function startTest(symbol: string, start: number, balance: number, leverage: number, spread: number, source: 'virtual' | 'mt4' = 'virtual'): Promise<string | null> {
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
    // ほかの銘柄は今の検証の値（無ければ初期値）を引き継ぎ、選んだ銘柄だけ入力した値にする
    spreadPips: { ...DEFAULT_SPREAD_PIPS, ...state.test?.spreadPips, [md.symbol]: spread },
    ...(source === 'mt4' ? { source } : {}),
  };
  mt4AccountCache = null;
  applySpread();
  runner = null;
  freshRunner();
  renderChart(true);
  scrollToNow();
  refresh();
  updateStatus();
  save(true);
  return null;
}

$('#nt-start-btn').addEventListener('click', async () => {
  const start = fromLocalInput($<HTMLInputElement>('#nt-start').value, state.zone, rule);
  const balance = Number($<HTMLInputElement>('#nt-balance').value);
  const leverage = Number($<HTMLInputElement>('#nt-leverage').value);
  const spread = Number($<HTMLInputElement>('#nt-spread').value);
  if (!Number.isFinite(start)) return void ($('#nt-error').textContent = '開始日時を入力してください');
  if (!(balance > 0) || !(leverage >= 1)) return void ($('#nt-error').textContent = '初期資金とレバレッジを確認してください');
  if (!(spread >= 0)) return void ($('#nt-error').textContent = 'スプレッドを確認してください（0 以上）');
  const source = $<HTMLSelectElement>('#nt-source').value === 'mt4' ? 'mt4' : 'virtual';
  const err = await startTest($<HTMLSelectElement>('#nt-symbol').value || md.symbol, start, balance, leverage, spread, source);
  if (err) $('#nt-error').textContent = err;
  else $<HTMLDialogElement>('#newtest-dialog').close();
});


// ---------------- MT4 の取引履歴 ----------------
// 記録の時刻・価格のまま表示する（R2）。ローソク足を進めると、記録どおりにエントリー・決済が現れる。

/** 今の銘柄の時刻のずれ。まだ判定していなければ、ほかの銘柄で判定した値（同じブローカーなら同じはず） */
function mt4Offset() {
  const m = state.mt4;
  const d = m?.bySymbol?.[md.symbol];
  return d ? { ...d, detected: true } : { hours: m?.offsetHours ?? 0, matched: 0, checked: 0, detected: false };
}

function mt4ToUtc(server: number): number {
  return serverToUtc(server, rule) + mt4Offset().hours * 3_600_000;
}

/**
 * 今の銘柄の取引で時刻のずれを判定する（まだなら）。取引の期間の価格データも読み込む。
 * 価格データが無くて判定できなければ null
 */
async function detectMt4ForSymbol(): Promise<{ hours: number; matched: number; checked: number } | null> {
  const m = state.mt4;
  if (!m) return null;
  if (m.bySymbol?.[md.symbol]) return m.bySymbol[md.symbol];
  const mine = mt4Trades();
  if (!mine.length) return null;
  const opens = mine.map((t) => serverToUtc(t.openServer, rule));
  const closes = mine.map((t) => (t.closeServer === null ? NaN : serverToUtc(t.closeServer, rule))).filter(Number.isFinite);
  // 判定には新しい方の取引の期間だけを読み込む（読み込める月数に上限があるため）。終わったら今の時刻の辺りに戻す
  const last = Math.max(...opens, ...closes);
  await ensureWindow(Math.max(Math.min(...opens), last - HISTORY_LIMIT) - 86_400_000, last + 86_400_000);
  const det = detectOffsetHours(mine, (sv) => serverToUtc(sv, rule), priceLookup, spec.pip);
  if (state.cursor) await ensureLoaded(state.cursor - 62 * 86_400_000, state.cursor);
  if (det.checked === 0) return null;
  const result = { hours: det.hours, matched: det.matched, checked: det.checked };
  (m.bySymbol ??= {})[md.symbol] = result;
  m.offsetHours = det.hours;
  mt4EventCache = null;
  return result;
}

function mt4Trades(): Mt4Trade[] {
  return (state.mt4?.trades ?? []).filter((t) => t.symbol.toLowerCase() === md.symbol);
}

const priceLookup: PriceLookup = {
  bar(utc) {
    const t = Math.floor(utc / 60_000) * 60_000;
    const j = md.indexAtOrBefore(t);
    return j >= 0 && md.bid[j].t === t ? { bid: md.bid[j], ask: md.ask[j] } : null;
  },
};

let mt4EventCache: { key: string; events: { t: number; label: string }[] } | null = null;

/** エントリー・決済が起きる 1 分足の時刻（昇順） */
function mt4Events() {
  const key = `${md.symbol}:${state.mt4?.fileName}:${state.mt4?.trades.length}:${mt4Offset().hours}`;
  if (mt4EventCache?.key === key) return mt4EventCache.events;
  const minute = (t: number) => Math.floor(t / 60_000) * 60_000;
  const events: { t: number; label: string }[] = [];
  for (const t of mt4Trades()) {
    events.push({ t: minute(mt4ToUtc(t.openServer)), label: `MT4 #${t.ticket} ${t.side} エントリー` });
    if (t.closeServer !== null) events.push({ t: minute(mt4ToUtc(t.closeServer)), label: `MT4 #${t.ticket} 決済（${formatMoney(t.profit + t.swap + t.commission)}）` });
  }
  events.sort((a, b) => a.t - b.t);
  mt4EventCache = { key, events };
  return events;
}

/** その 1 分足で起きた MT4 のエントリー・決済 */
function mt4EventsIn(barT: number): string[] {
  const ev = mt4Events();
  if (!ev.length) return [];
  const i = lastLE(
    ev.map((e) => e.t),
    barT,
  );
  const out: string[] = [];
  for (let j = i; j >= 0 && ev[j].t === barT; j--) out.unshift(ev[j].label);
  return out;
}

function mt4Rows(): Mt4Row[] {
  const end = md.bid[cursor].t + 60_000;
  return mt4Trades().map((t) => {
    const openUtc = mt4ToUtc(t.openServer);
    const closeUtc = t.closeServer === null ? null : mt4ToUtc(t.closeServer);
    const status = openUtc >= end ? 'wait' : closeUtc !== null && closeUtc < end ? 'closed' : 'open';
    let floating: number | null = null;
    if (status === 'open') {
      const now = t.side === 'buy' ? md.bid[cursor].c : md.ask[cursor].c;
      floating = (now - t.openPrice) * (t.side === 'buy' ? 1 : -1) * t.lots * spec.contract * jpyRate(cursor);
    }
    const m = matchTrade(t, mt4ToUtc, priceLookup, spec.pip);
    return {
      ticket: t.ticket,
      side: t.side,
      lots: t.lots,
      openUtc,
      openPrice: t.openPrice,
      sl: t.sl,
      tp: t.tp,
      closeUtc,
      closePrice: t.closePrice,
      swap: t.swap,
      commission: t.commission,
      profit: t.profit,
      status,
      floating,
      matchOpen: m.open,
      matchClose: m.close,
    } satisfies Mt4Row;
  });
}

function mt4View() {
  if (!state.mt4) return null;
  const rows = mt4Rows();
  return {
    open: rows
      .filter((r) => r.status === 'open')
      .map((r) => ({ ticket: r.ticket, side: r.side, lots: r.lots, openTime: r.openUtc, openPrice: r.openPrice, sl: r.sl, tp: r.tp })),
    closed: rows
      .filter((r) => r.status === 'closed')
      .map((r) => ({
        kind: 'trade' as const,
        ticket: r.ticket,
        symbol: md.symbol.toUpperCase(),
        side: r.side,
        lots: r.lots,
        openTime: r.openUtc,
        openPrice: r.openPrice,
        sl: r.sl,
        tp: r.tp,
        closeTime: r.closeUtc!,
        closePrice: r.closePrice!,
        profit: r.profit,
        reason: 'manual' as const,
        comment: '',
      })),
  };
}

/** from〜to（UTC）の価格データが無ければ読み込む（上限の月数まで）。表示も描き直す */
async function ensureLoaded(from: number, to: number) {
  await ensureWindow(from, to);
  renderChart(true, true);
  updateStatus();
}

/** 1 分足で読み込むインジケーター用の過去データの上限（H1 より短い時間足。読み込める月数の上限から、今の月と次の月の分を除く） */
const HISTORY_LIMIT = (MAX_MONTHS - 2) * 30 * 86_400_000;
/** H1 以上の時間足のインジケーター用の過去データの上限（1 時間足で持つので軽い） */
const HOURLY_LIMIT = 5 * 365 * 86_400_000;
let loadingHistory = false;

// ---- H1 以上の時間足の過去（読み込んでいる 1 分足より前） ----
// 日足・週足の SMA(200) などには何年分もの足が要る。1 分足で持つとメモリを食い、時間足を変えるたびに
// まとめ直すのも重いので、月ごとに 1 時間足にまとめて持つ（1 分足は捨てる）。
// H4・D1・W1・MN の区切り（サーバー時刻の正時）は 1 時間足の区切りと重なるので、1 時間足からまとめても同じ足になる。

/** `${銘柄}:${月}` → その月の 1 時間足（Bid） */
const hourlyCache = new Map<string, Bar[]>();

/** 読み込んでいる 1 分足の範囲の前に続く 1 時間足（月がつながっている分だけ） */
function hourlyBefore(): Bar[] {
  const [lo] = md.windowRange;
  const parts: Bar[][] = [];
  for (let i = lo - 1; i >= 0; i--) {
    const h = hourlyCache.get(`${md.symbol}:${md.months[i]}`);
    if (!h) break;
    parts.unshift(h);
  }
  const start = md.bid.length ? md.bid[0].t : Infinity;
  return parts.flat().filter((b) => b.t < start);
}

/**
 * 1 分足からまとめた足の前に、1 時間足の過去をまとめた足を付ける（H1 以上の時間足だけ）。
 * 過去の足の starts（1 分足の位置）は負の数にする（1 分足の範囲の外。lastLE で今の足を探すのには使わない）
 */
function withHistory(agg: Aggregated, tf: Timeframe): Aggregated {
  if (TIMEFRAMES[tf] < 60) return agg;
  const hourly = hourlyBefore();
  if (!hourly.length) return agg;
  const past = aggregateWithIndex(hourly, tf, rule).bars;
  // 1 分足の範囲の始まりをまたぐ足（日足・月足など）は 1 本にまとめる
  if (past.length && agg.bars.length && past[past.length - 1].t === agg.bars[0].t) {
    const a = past.pop()!;
    const b = agg.bars[0];
    agg.bars[0] = { t: b.t, o: a.o, h: Math.max(a.h, b.h), l: Math.min(a.l, b.l), c: b.c };
  }
  return { bars: [...past, ...agg.bars], starts: [...past.map((_, i) => i - past.length), ...agg.starts] };
}

/** from（UTC）から 1 分足の範囲の前までの月を、1 時間足にして持つ。足したら true */
async function loadHourly(from: number): Promise<boolean> {
  const [lo] = md.windowRange;
  const symbol = md.symbol;
  const want: string[] = [];
  for (let i = Math.max(0, md.monthIndexOf(from)); i < lo; i++) if (!hourlyCache.has(`${symbol}:${md.months[i]}`)) want.push(md.months[i]);
  if (!want.length) return false;
  // 一度に読むのは数か月ずつ（1 分足を長く持たないように）。新しい月から
  for (let end = want.length; end > 0; end -= 6) {
    const chunk = want.slice(Math.max(0, end - 6), end);
    const { bid } = await loadMonths(symbol, chunk, md.digits);
    for (const m of chunk) {
      const lo = Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1, 1);
      const hi = Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 1);
      hourlyCache.set(`${symbol}:${m}`, aggregateWithIndex(bid.filter((b) => b.t >= lo && b.t < hi), 'H1', rule).bars);
    }
    if (md.symbol !== symbol) return false;
  }
  return true;
}

/**
 * 表示しているチャートのインジケーターに必要な分だけ、前のデータを読み込む。
 * 例: 日足の SMA(200) には 200 日分の足が要る。足りないと線が途中から始まったり、
 * EMA が MT4 と違う値になったりする（EMA は初めの値の影響が残るので、期間の 3 倍を見る）。
 * 週末など足の無い時間があるので 1.5 倍の期間を見る。
 * H1 より短い時間足は 1 分足で（最大 28 か月）、H1 以上は 1 時間足で（最大 5 年）持つ。
 */
async function ensureIndicatorHistory() {
  if (!manifest || loadingHistory || !md.hasEarlier) return;
  let needMinute = 0;
  let needHourly = 0;
  for (const p of visiblePanes()) {
    const cfg = indicatorsFor(p.tf);
    const bars = Math.max(
      0,
      ...cfg.ma.filter((m) => m.enabled).map((m) => (m.type === 'ema' ? m.period * 3 : m.period)),
      ...cfg.rci.flatMap((r) => (r.enabled ? r.lines.filter((l) => l.enabled).map((l) => l.period) : [])),
    );
    const span = (bars + 20) * TIMEFRAMES[p.tf] * 60_000 * 1.5;
    if (TIMEFRAMES[p.tf] < 60) needMinute = Math.max(needMinute, span);
    else needHourly = Math.max(needHourly, span);
  }
  const now = md.bid[cursor].t;
  if (traveling) return;
  loadingHistory = true;
  try {
    const from = now - Math.min(needMinute, HISTORY_LIMIT);
    if (needMinute && md.bid[0].t > from) await ensureLoaded(from, now);
    if (needHourly && (await loadHourly(now - Math.min(needHourly, HOURLY_LIMIT)))) {
      dataChanged();
      renderChart(true, true);
    }
  } finally {
    loadingHistory = false;
  }
}

async function readText(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  // MT4 のレポートは UTF-16 のことがある
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('shift_jis').decode(buf);
  }
}

async function loadMt4File(file: File) {
  const trades = parseHistoryFile(file.name, await readText(file));
  if (!trades.length) return toast('取引が見つかりませんでした（詳細レポートの .htm か、R_ExportHistory.mq4 の .csv を選んでください）');
  state.mt4 = { fileName: file.name, trades, offsetHours: 0, matched: 0, checked: 0, bySymbol: {} };
  mt4EventCache = null;
  const mine = mt4Trades();
  const det = await detectMt4ForSymbol();
  state.terminalTab = 'mt4';
  const symbols = [...new Set(trades.map((t) => t.symbol))].join(', ');
  // MT4 の取引の口座なら、検証を始める前に決済した取引は入らないことを知らせる
  const before = mt4Mode() ? trades.filter((t) => t.closeServer !== null && mt4ToUtc(t.closeServer) < test().startTime).length : 0;
  if (before) {
    toast(`${trades.length} 件を読み込みました。うち ${before} 件は検証の開始日時より前に決済した取引なので、口座には入りません（入れるには「新しい検証」で開始日時を前にしてください）`);
    refresh();
    renderTerminal(true);
    save(true);
    return;
  }
  toast(
    !mine.length
      ? `${trades.length} 件を読み込みましたが、${md.symbol.toUpperCase()} の取引はありません（含まれる銘柄: ${symbols}）。その銘柄を開くと表示し、時刻のずれもそのとき判定します`
      : det
        ? `${trades.length} 件を読み込みました（${md.symbol.toUpperCase()} は ${mine.length} 件）。時刻のずれ ${det.hours} 時間`
        : `${trades.length} 件を読み込みました（${md.symbol.toUpperCase()} は ${mine.length} 件）。その期間の価格データが無いため、時刻のずれは判定できませんでした`,
  );
  refresh();
  renderTerminal(true);
  save(true);
}

/**
 * 口座履歴の取引が見えるようにチャートを動かす（リプレイの時刻は動かさない。
 * 戻すと後の取引が取り消されてしまうため）
 */
function showHistoryTrade(ticket: number, closeTime: number) {
  const h = shownAccount().history.find((x) => x.kind === 'trade' && x.ticket === ticket && x.closeTime === closeTime);
  if (!h || h.kind !== 'trade') return;
  for (const p of panes) p.overlay.setHighlight({ openTime: h.openTime, closeTime: h.closeTime });
  for (const p of visiblePanes()) p.showTimeRange(h.openTime, h.closeTime);
  if (!panes[0].overlay.showHistory) $('#toggle-history').click();
}

async function jumpToTrade(ticket: number) {
  const t = mt4Trades().find((x) => x.ticket === ticket);
  if (!t) return;
  const openUtc = mt4ToUtc(t.openServer);
  // エントリーする足の 1 本前に置く（→ で進めるとエントリーが現れる）
  await travel(Math.floor(openUtc / 60_000) * 60_000 - 60_000);
}

// ---------------- EasyOrder ----------------
// 損切りの位置と、許容する損失（残高の % か金額）からロット数を計算して発注する。

function roundPrice(p: number) {
  return Number(p.toFixed(md.digits));
}

function eoCalc() {
  const e = eo();
  const bid = md.bid[cursor].c;
  const ask = md.ask[cursor].c;
  if (e.sl === null) return { ok: false, error: '損切り（S/L）の価格を入れてください' } as const;
  const ref = e.mode === 'market' ? bid : (e.entry ?? bid);
  const side: Side = e.sl < ref ? 'buy' : 'sell';
  const entry = e.mode === 'market' ? (side === 'buy' ? ask : bid) : ref;
  const type: 'market' | PendingType =
    e.mode === 'market' ? 'market' : side === 'buy' ? (entry < ask ? 'buylimit' : 'buystop') : entry > bid ? 'selllimit' : 'sellstop';
  const rate = jpyRate(cursor);
  const riskJpy = e.riskUnit === 'pct' ? (account.balance * e.risk) / 100 : e.risk;
  const lots = lotsForRisk({ riskJpy, entry, sl: e.sl, contract: spec.contract, rate });
  const dir = side === 'buy' ? 1 : -1;
  const slPips = ((e.sl - entry) * dir) / spec.pip;
  const tpPips = e.tp === null ? null : ((e.tp - entry) * dir) / spec.pip;
  let error: string | null = null;
  if (!Number.isFinite(rate)) error = '円に換算できません（USDJPY のデータが必要です）';
  else if (lots < 0.01) error = '最小ロット（0.01）でも損失が指定を超えます。S/L を近づけるか、許容する損失を増やしてください';
  return {
    ok: true as const,
    error,
    side,
    entry,
    type,
    lots,
    riskJpy,
    loss: lossAt(lots, entry, e.sl, spec.contract, rate),
    reward: e.tp === null ? null : Math.abs(e.tp - entry) * lots * spec.contract * rate,
    rr: tpPips === null ? null : tpPips / -slPips,
    slPips,
    tpPips,
  };
}

const TYPE_JA: Record<string, string> = {
  market: '成行',
  buylimit: '買い指値',
  buystop: '買い逆指値',
  selllimit: '売り指値',
  sellstop: '売り逆指値',
};

/**
 * S/L・T/P（指値・逆指値ならエントリーも）を今の価格の近くに置く。開くたびに置き直す。
 * 離す幅は、今のチャートに見えている価格の幅の 6%（どの銘柄・時間足・拡大率でも画面の上で同じくらいの近さ）。T/P はその 2 倍（RR 2）
 */
function eoSetDefaults() {
  const e = eo();
  const bid = md.bid[cursor].c;
  const span = active.visiblePriceSpan();
  const d = Math.max(spec.pip, span ? span * 0.06 : 20 * spec.pip);
  e.entry = e.mode === 'pending' ? roundPrice(bid) : null;
  e.sl = roundPrice(bid - d);
  e.tp = roundPrice(bid + 2 * d);
}

function eoPreview(): OrderPreview | null {
  const e = eo();
  if (!e.open) return null;
  const c = eoCalc();
  if (!c.ok) return { side: 'buy', entry: e.mode === 'pending' ? e.entry : null, sl: e.sl, tp: e.tp, labels: { entry: 'EO', sl: 'EO S/L', tp: 'EO T/P' } };
  return {
    side: c.side,
    entry: e.mode === 'pending' ? c.entry : null,
    sl: e.sl,
    tp: e.tp,
    labels: {
      entry: `EO ${TYPE_JA[c.type]} ${c.lots.toFixed(2)}`,
      sl: `EO S/L ${c.slPips.toFixed(1)}p ${formatMoney(-c.loss)}円`,
      tp: c.tpPips === null ? '' : `EO T/P ${c.tpPips.toFixed(1)}p`,
    },
  };
}

function eoRender() {
  const e = eo();
  const panel = $('#easyorder');
  panel.hidden = !e.open;
  $('#easyorder-btn').setAttribute('aria-pressed', String(e.open));
  if (!e.open) return;
  const setVal = (id: string, v: number | null, digits = md.digits) => {
    const el = $<HTMLInputElement>(id);
    if (document.activeElement !== el) el.value = v === null ? '' : v.toFixed(digits);
  };
  $<HTMLSelectElement>('#eo-mode').value = e.mode;
  $<HTMLSelectElement>('#eo-unit').value = e.riskUnit;
  setVal('#eo-risk', e.risk, e.riskUnit === 'pct' ? 1 : 0);
  setVal('#eo-sl', e.sl);
  setVal('#eo-tp', e.tp);
  setVal('#eo-entry', e.entry);
  $('#eo-entry-row').hidden = e.mode !== 'pending';
  for (const id of ['#eo-sl', '#eo-tp', '#eo-entry']) $<HTMLInputElement>(id).step = String(10 ** -md.digits);
  const c = eoCalc();
  const btn = $<HTMLButtonElement>('#eo-send');
  if (!c.ok) {
    $('#eo-calc').innerHTML = `<span class="err">${c.error}</span>`;
    btn.disabled = true;
    btn.textContent = '—';
    return;
  }
  $('#eo-sl-pips').textContent = `${c.slPips.toFixed(1)} pips`;
  $('#eo-tp-pips').textContent = c.tpPips === null ? '' : `${c.tpPips.toFixed(1)} pips`;
  $('#eo-entry-info').textContent = e.mode === 'pending' ? TYPE_JA[c.type] : '';
  const rr = c.rr === null ? '' : `　RR <b>${c.rr.toFixed(2)}</b>`;
  const reward = c.reward === null ? '' : `　利益 <b>${formatMoney(c.reward)}</b> 円`;
  $('#eo-calc').innerHTML =
    `ロット <b>${c.lots.toFixed(2)}</b>　損失 <b class="neg">${formatMoney(c.loss)}</b> 円（上限 ${formatMoney(c.riskJpy)}）${reward}${rr}` +
    (c.error ? `<br><span class="err">${c.error}</span>` : '');
  btn.disabled = !!c.error;
  btn.className = c.side;
  btn.textContent = `${c.side === 'buy' ? '買い' : '売り'} ${c.lots.toFixed(2)} ロット（${TYPE_JA[c.type]}）`;
}

function eoSend() {
  const e = eo();
  const c = eoCalc();
  if (!c.ok || c.error) return toast(c.error ?? '');
  const ok =
    c.type === 'market'
      ? act({ kind: 'market', side: c.side, lots: c.lots, sl: e.sl, tp: e.tp })
      : act({ kind: 'pending', type: c.type, price: c.entry, lots: c.lots, sl: e.sl, tp: e.tp });
  if (ok) {
    // 発注したら、注文の線と重ならないように閉じる（入力は次回のために残す）
    e.open = false;
    e.entry = null;
    refresh();
  }
}

function setupEasyOrder() {
  const e = () => eo();
  $('#easyorder-btn').addEventListener('click', () => {
    e().open = !e().open;
    // 開くたびに、S/L・T/P を今の価格の近くに置き直す（前回の位置は使わない）
    if (e().open) eoSetDefaults();
    refresh();
  });
  $('#eo-close').addEventListener('click', () => {
    e().open = false;
    refresh();
  });
  $('#eo-mode').addEventListener('change', (ev) => {
    e().mode = (ev.target as HTMLSelectElement).value as EasyOrderState['mode'];
    // 成行 ↔ 指値・逆指値を切り替えても、S/L・T/P は動かさない（エントリーが無ければ今の価格に置く）
    if (e().mode === 'pending' && e().entry === null) e().entry = roundPrice(md.bid[cursor].c);
    refresh();
  });
  $('#eo-unit').addEventListener('change', (ev) => {
    const unit = (ev.target as HTMLSelectElement).value as EasyOrderState['riskUnit'];
    // 単位を変えても同じ金額になるように換算する
    e().risk = unit === 'jpy' ? Math.round((account.balance * e().risk) / 100) : Math.round((e().risk / account.balance) * 1000) / 10;
    e().riskUnit = unit;
    refresh();
  });
  const bindNum = (id: string, field: 'risk' | 'sl' | 'tp' | 'entry', allowEmpty: boolean) =>
    $(id).addEventListener('change', (ev) => {
      const el = ev.target as HTMLInputElement;
      const v = el.value.trim() === '' ? null : Number(el.value);
      if (v === null && !allowEmpty) return refresh();
      if (v !== null && !Number.isFinite(v)) return refresh();
      (e() as unknown as Record<string, number | null>)[field] = v;
      refresh();
    });
  bindNum('#eo-risk', 'risk', false);
  bindNum('#eo-sl', 'sl', false);
  bindNum('#eo-tp', 'tp', true);
  bindNum('#eo-entry', 'entry', false);
  $('#eo-send').addEventListener('click', eoSend);
  for (const p of panes)
    p.overlay.onPreviewEdit = (field, price) => {
      e()[field] = roundPrice(price);
      refresh();
    };
}

// ---------------- インジケーターの設定 ----------------
/** チャートごとの設定（時間足とインジケーター） */
function paneState(p: ChartPane): PaneState {
  return state.panes![p.index];
}

/** 線の太さを選ぶ欄（1〜4 px） */
function widthCell(i: number, w: number | undefined) {
  const cur = w ?? 1;
  return `<td><select data-i="${i}" data-f="width" title="線の太さ">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${n === cur ? 'selected' : ''}>${n}</option>`).join('')}</select></td>`;
}

function openIndicatorDialog(cfg: IndicatorConfig = indicatorsFor(active.tf)) {
  cfg = normalizeIndicators(cfg);
  $('#ind-title').textContent = `インジケーター（${active.tf} 用 ・ ${active.tf} のチャートすべてに使う）`;
  const ma = $('#ind-ma');
  ma.innerHTML =
    '<tr><td></td><td>期間</td><td>種類</td><td>色</td><td>太さ</td></tr>' +
    cfg.ma
      .map(
        (m, i) => `<tr><td><input type="checkbox" data-i="${i}" data-f="enabled" ${m.enabled ? 'checked' : ''} /></td>
        <td><input type="number" min="1" step="1" data-i="${i}" data-f="period" value="${m.period}" /></td>
        <td><select data-i="${i}" data-f="type"><option value="sma" ${m.type === 'sma' ? 'selected' : ''}>単純（SMA）</option><option value="ema" ${m.type === 'ema' ? 'selected' : ''}>指数（EMA）</option></select></td>
        <td><input type="color" data-i="${i}" data-f="color" value="${m.color}" /></td>${widthCell(i, m.width)}</tr>`,
      )
      .join('');
  $('#ind-rci-wrap').innerHTML = cfg.rci
    .map(
      (rp, k) => `<h3>RCI ${k + 1} 段目（サブウィンドウ）<label class="inline"><input class="ind-rci-on" data-k="${k}" type="checkbox" ${rp.enabled ? 'checked' : ''} /> 表示する</label></h3>
      <table class="ind-table" id="ind-rci-${k}"><tr><td></td><td>期間</td><td>色</td><td>太さ</td></tr>${rp.lines
        .map(
          (l, i) => `<tr><td><input type="checkbox" data-i="${i}" data-f="enabled" ${l.enabled ? 'checked' : ''} /></td>
          <td><input type="number" min="2" step="1" data-i="${i}" data-f="period" value="${l.period}" /></td>
          <td><input type="color" data-i="${i}" data-f="color" value="${l.color}" /></td>${widthCell(i, l.width)}</tr>`,
        )
        .join('')}</table>`,
    )
    .join('');
  const dlg = $<HTMLDialogElement>('#ind-dialog');
  if (!dlg.open) dlg.showModal();
}

function readIndicatorDialog(): IndicatorConfig {
  const rows = <T extends object>(table: string, base: T[]): T[] =>
    base.map((b, i) => {
      const out = { ...b } as Record<string, unknown>;
      document.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`${table} [data-i="${i}"]`).forEach((el) => {
        const f = el.dataset.f!;
        out[f] =
          el instanceof HTMLInputElement && el.type === 'checkbox'
            ? el.checked
            : f === 'period'
              ? Math.max(1, Math.round(Number(el.value)))
              : f === 'width'
                ? Math.max(1, Math.min(4, Number(el.value)))
                : el.value;
      });
      return out as T;
    });
  const cur = indicatorsFor(active.tf);
  return {
    ma: rows('#ind-ma', cur.ma),
    rci: cur.rci.map((rp, k) => ({
      enabled: document.querySelector<HTMLInputElement>(`.ind-rci-on[data-k="${k}"]`)!.checked,
      lines: rows(`#ind-rci-${k}`, rp.lines),
    })),
  };
}

/** 時間足の設定を変えて、その時間足のチャートに反映する */
function applyIndicators(tfs: string[], cfg: IndicatorConfig) {
  for (const tf of tfs) state.indicatorSets![tf] = structuredClone(cfg);
  for (const p of panes) if (tfs.includes(p.tf)) p.indicators.setConfig(indicatorsFor(p.tf));
  save();
  void ensureIndicatorHistory();
}

// ---------------- 図形の色（時間足ごと） ----------------
function openColorDialog(colors: Record<string, string>) {
  $('#color-table').innerHTML = (Object.keys(TIMEFRAMES) as Timeframe[])
    .map((tf) => `<tr><td>${tf}</td><td><input type="color" data-tf="${tf}" value="${colors[tf] ?? DEFAULT_TF_COLORS[tf]}" /></td></tr>`)
    .join('');
  const dlg = $<HTMLDialogElement>('#color-dialog');
  if (!dlg.open) dlg.showModal();
}

// ---------------- フィボナッチの水準 ----------------
type FiboKind = 'fibo' | 'fiboexp';
const DEFAULT_LEVELS: Record<FiboKind, readonly number[]> = { fibo: FIBO_LEVELS, fiboexp: FIBO_EXP_LEVELS };
const levelsOf = (k: FiboKind) => state.fiboLevels?.[k] ?? DEFAULT_LEVELS[k];

function levelRow(v: number | '') {
  return `<tr><td><input type="number" step="any" value="${v}" /></td><td><button type="button" title="この水準を消す">✕</button></td></tr>`;
}

function openLevelsDialog(levels: (k: FiboKind) => readonly number[] = levelsOf) {
  for (const k of ['fibo', 'fiboexp'] as const) {
    // 割合 → %（0.618 → 61.8。小数の誤差を出さない）
    $(`#levels-${k}`).innerHTML = levels(k).map((lv) => levelRow(Math.round(lv * 1e6) / 1e4)).join('');
  }
  $('#levels-error').textContent = '';
  const dlg = $<HTMLDialogElement>('#levels-dialog');
  if (!dlg.open) dlg.showModal();
}

function applyLevelsDialog() {
  const read = (k: FiboKind) =>
    levelsFromPercents([...document.querySelectorAll<HTMLInputElement>(`#levels-${k} input`)].filter((el) => el.value.trim() !== '').map((el) => Number(el.value)));
  const fibo = read('fibo');
  const fiboexp = read('fiboexp');
  if (!fibo.length || !fiboexp.length) {
    $('#levels-error').textContent = 'それぞれ 1 つ以上の水準を入れてください';
    return;
  }
  state.fiboLevels = { fibo, fiboexp };
  for (const p of panes) p.drawings.refresh();
  $<HTMLDialogElement>('#levels-dialog').close();
  save();
}

// ---------------- キーボードのショートカット ----------------
/** 画面で編集中の割り当て */
let keyDraft: Record<string, string[]> = {};
/** キーを待っている枠（働きと何番目か） */
let keyWaiting: { id: string; slot: number } | null = null;

function openKeysDialog(map: Record<string, string[]> = resolveKeymap(state.keymap)) {
  keyDraft = structuredClone(map);
  keyWaiting = null;
  renderKeysDialog();
  const dlg = $<HTMLDialogElement>('#keys-dialog');
  if (!dlg.open) dlg.showModal();
}

function renderKeysDialog(note = '') {
  let group = '';
  const rows: string[] = [];
  for (const c of KEY_COMMANDS) {
    if (c.group !== group) {
      group = c.group;
      rows.push(`<tr><th colspan="3">${group}</th></tr>`);
    }
    const slot = (n: number) => {
      const k = keyDraft[c.id]?.[n];
      const waiting = keyWaiting?.id === c.id && keyWaiting.slot === n;
      return `<td><button type="button" class="key-slot${waiting ? ' waiting' : ''}" data-id="${c.id}" data-slot="${n}">${waiting ? 'キーを押す…' : k ? keyLabel(k) : '—'}</button></td>`;
    };
    rows.push(`<tr><td>${c.label}</td>${slot(0)}${slot(1)}</tr>`);
  }
  $('#keys-table').innerHTML = rows.join('');
  $('#keys-note').textContent = note;
}

/** キーを待っている枠に k を入れる（null は空にする）。ほかの働きに付いていたら外す */
function assignKey(k: string | null) {
  if (!keyWaiting) return;
  const { id, slot } = keyWaiting;
  keyWaiting = null;
  let note = '';
  const list = [...(keyDraft[id] ?? [])];
  if (k) {
    for (const c of KEY_COMMANDS) {
      if (c.id === id || !keyDraft[c.id]?.includes(k)) continue;
      keyDraft[c.id] = keyDraft[c.id].filter((x) => x !== k);
      note = `${keyLabel(k)} は「${c.label}」から外しました`;
    }
    const other = list.indexOf(k);
    if (other >= 0) list.splice(other, 1);
    list.splice(Math.min(slot, list.length), slot < list.length ? 1 : 0, k);
  } else if (slot < list.length) list.splice(slot, 1);
  keyDraft[id] = list.slice(0, 2);
  renderKeysDialog(note);
}

// ---------------- プロジェクト ----------------
// 検証（口座・時刻）・図形・インジケーター・MT4 履歴をまとめて保存する。切り替えるとページを読み直す。

let leaving = false;

/** 今のプロジェクトを保存し終えてから fn（切り替えなど）を行い、ページを読み直す */
async function reloadInto(fn: () => Promise<unknown>) {
  if (leaving) return;
  setPlaying(false);
  saveState(state);
  await flushSave();
  leaving = true;
  try {
    await fn();
  } catch (e) {
    leaving = false;
    toast(e instanceof Error ? e.message : String(e));
    return;
  }
  location.reload();
}

// ---- 左上のプロジェクトの一覧（フォルダの木） ----
// ボタンに今のプロジェクトの名前を出し、押すとフォルダの木を開く。フォルダは開く・閉じるができ、開いた状態はこの Mac に覚える。
// 一番上の「＋ 新規」「📁＋」と、フォルダの行にマウスを乗せると出るボタン（＋ 中に新規 / 📁＋ 中にフォルダ / ✎ 名前 / 🗑 空なら消す）で作る。
// プロジェクトはドラッグしてフォルダに落とすと移る（一番上の行に落とすとフォルダの外へ）。

const OPEN_FOLDERS_KEY = 'fx-practice-open-folders';

interface FolderNode {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  projects: ProjectMeta[];
}

function projectTree(): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: new Map(), projects: [] };
  const nodeAt = (folder: string) => {
    let node = root;
    for (const part of folder.split('/').filter(Boolean)) {
      const path = node.path ? `${node.path}/${part}` : part;
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path, folders: new Map(), projects: [] });
      node = node.folders.get(part)!;
    }
    return node;
  };
  // 空のフォルダも出す
  for (const f of listFolders()) nodeAt(f);
  for (const p of listProjects()) nodeAt(p.folder ?? '').projects.push(p);
  return root;
}

function openFolders(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function saveOpenFolders(open: Set<string>) {
  try {
    localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...open]));
  } catch {
    // 覚えられなくても開閉はできる
  }
}

/** folder とその親を開いた状態にする */
function openFolder(folder: string) {
  const open = openFolders();
  const parts = folder.split('/').filter(Boolean);
  parts.forEach((_, i) => open.add(parts.slice(0, i + 1).join('/')));
  saveOpenFolders(open);
}

function renderProjectPanel() {
  const open = openFolders();
  const cur = currentMeta();
  // 今のプロジェクトが入っているフォルダはいつも開いておく
  const parts = (cur.folder ?? '').split('/').filter(Boolean);
  parts.forEach((_, i) => open.add(parts.slice(0, i + 1).join('/')));
  const count = (n: FolderNode): number => n.projects.length + [...n.folders.values()].reduce((s, f) => s + count(f), 0);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const html = (n: FolderNode): string => {
    const folders = [...n.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    return `<ul>${folders
      .map((f) => {
        const isOpen = open.has(f.path);
        const c = count(f);
        const p = esc(f.path);
        return `<li class="pj-folder"><div class="pj-row pj-drop" data-folder="${p}" draggable="false">
          <span class="pj-name">${isOpen ? '▾' : '▸'} 📁 ${esc(f.name)}</span><span class="pj-count">${c}</span>
          <span class="pj-acts"><button type="button" data-act="new" data-folder="${p}" title="この中に新しいプロジェクト">＋</button><button type="button" data-act="mkdir" data-folder="${p}" title="この中にフォルダを作る">📁＋</button><button type="button" data-act="rename" data-folder="${p}" title="フォルダの名前を変える">✎</button>${c ? '' : `<button type="button" data-act="rmdir" data-folder="${p}" title="この空のフォルダを消す">🗑</button>`}</span>
        </div>${isOpen ? html(f) : ''}</li>`;
      })
      .join('')}${n.projects
      .map((p) => `<li><div class="pj-row${p.id === cur.id ? ' pj-current' : ''}" data-project="${p.id}" draggable="true" title="クリックで開く。ドラッグしてフォルダに落とすと移る">${p.id === cur.id ? '✓ ' : '　'}${esc(p.name)}</div></li>`)
      .join('')}</ul>`;
  };
  $('#project-panel').innerHTML = `<div class="pj-head pj-drop" data-folder="" title="ここにプロジェクトを落とすと、フォルダの外に出す">
      <span>プロジェクト</span>
      <span class="pj-head-acts"><button type="button" data-act="new" data-folder="" title="新しいプロジェクト（フォルダの外）">＋ 新規</button><button type="button" data-act="mkdir" data-folder="" title="フォルダを作る">📁＋</button></span>
    </div>${html(projectTree())}`;
}

function renderProjectButton() {
  const cur = currentMeta();
  const btn = $('#project');
  btn.textContent = cur.name;
  // メモの最初の数行もマウスを乗せると出す
  const note = (state?.note ?? '').trim().split('\n').slice(0, 4).join('\n');
  btn.title = `${cur.folder ? `${cur.folder.split('/').join(' ／ ')} ／ ` : ''}${cur.name}（クリックでプロジェクトの一覧）${note ? `\n\n${note}` : ''}`;
}

function setProjectPanel(show: boolean) {
  const panel = $('#project-panel');
  if (show) {
    renderProjectPanel();
    const r = $('#project').getBoundingClientRect();
    panel.style.left = `${Math.max(4, r.left)}px`;
    panel.style.top = `${r.bottom + 4}px`;
  }
  panel.hidden = !show;
  $('#project').setAttribute('aria-expanded', String(show));
}

/** 定型の一覧（起動したときと、定型の画面を開いたときに読む） */
let templatesCache: { templates: ChartTemplate[]; default: string | null } = { templates: [], default: null };
const defaultTemplate = () => templatesCache.templates.find((t) => t.name === templatesCache.default) ?? null;

/**
 * 新しいプロジェクトの中身。「★」の定型があればそれを使い、無ければ今のプロジェクトの
 * 銘柄・並べ方・時間足・インジケーター・図形の色・右の余白などを引き継ぐ
 */
function newProjectState(): AppState {
  const t = defaultTemplate();
  if (t) return applyTemplate({ ...defaultState(), symbol: state.symbol, keymap: structuredClone(state.keymap) }, t.settings);
  return {
    ...defaultState(),
    symbol: state.symbol,
    zone: state.zone,
    layout: state.layout,
    panes: structuredClone(state.panes),
    indicatorSets: structuredClone(state.indicatorSets),
    tfColors: structuredClone(state.tfColors),
    fiboLevels: structuredClone(state.fiboLevels),
    keymap: structuredClone(state.keymap),
    hiddenTfs: structuredClone(state.hiddenTfs),
    hideOneClick: state.hideOneClick,
    rightOffset: state.rightOffset,
  };
}

function newProjectIn(folder: string | undefined) {
  const where = folder ? `「${folder.split('/').join(' ／ ')}」の中に` : '';
  const t = defaultTemplate();
  const name = prompt(`${where}新しいプロジェクトの名前（${t ? `定型「${t.name}」で作ります` : '今のプロジェクトの設定を引き継ぎます'}）`, `プロジェクト ${listProjects().length + 1}`);
  if (!name) return;
  reloadInto(() => createProject(name, newProjectState(), folder || undefined));
}

async function folderAction(act: string, folder: string) {
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e));
  if (act === 'new') return newProjectIn(folder);
  if (act === 'mkdir') {
    const name = prompt(folder ? `「${folder.split('/').join(' ／ ')}」の中に作るフォルダの名前` : '作るフォルダの名前');
    if (!name?.trim()) return;
    if (name.includes('/')) return toast('フォルダの名前に / は使えません（中にフォルダを作るときは、そのフォルダの 📁＋ を押してください）');
    try {
      const f = await createFolder(folder ? `${folder}/${name}` : name);
      openFolder(f);
      renderProjectPanel();
    } catch (e) {
      fail(e);
    }
    return;
  }
  if (act === 'rename') {
    const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';
    const name = prompt('フォルダの新しい名前', folder.slice(parent ? parent.length + 1 : 0));
    if (!name?.trim()) return;
    if (name.includes('/')) return toast('フォルダの名前に / は使えません');
    try {
      const to = await renameFolder(folder, parent ? `${parent}/${name}` : name);
      // 開いていたフォルダは、名前を変えた後も開いたままにする
      const open = openFolders();
      saveOpenFolders(new Set([...open].map((x) => (x === folder ? to : x.startsWith(`${folder}/`) ? to + x.slice(folder.length) : x))));
      openFolder(to);
      renderProjectPanel();
      renderProjectButton();
    } catch (e) {
      fail(e);
    }
    return;
  }
  if (act === 'rmdir') {
    if (!confirm(`空のフォルダ「${folder.split('/').join(' ／ ')}」を消しますか？`)) return;
    try {
      await deleteFolder(folder);
      renderProjectPanel();
    } catch (e) {
      fail(e);
    }
  }
}

// ---- 定型の画面 ----
function renderTemplates() {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const rows = templatesCache.templates.map((t) => {
    const isDefault = t.name === templatesCache.default;
    const n = esc(t.name);
    return `<tr><td class="${isDefault ? 'tpl-default' : ''}">${isDefault ? '★ ' : ''}${n}</td><td>
      <button type="button" data-tpl="apply" data-name="${n}" title="このプロジェクトの並べ方・インジケーター・色などを、この定型にする">当てる</button>
      <button type="button" data-tpl="default" data-name="${n}" title="新しいプロジェクトを作るときにこの定型を使う">${isDefault ? '★ 解除' : '★ 新規に使う'}</button>
      <button type="button" data-tpl="overwrite" data-name="${n}" title="今のチャートの設定で、この定型を上書きする">上書き</button>
      <button type="button" data-tpl="delete" data-name="${n}">削除</button></td></tr>`;
  });
  $('#tpl-table').innerHTML = rows.length
    ? rows.join('')
    : '<tr><td colspan="2" class="hint">まだ定型がありません。下で名前を付けて、今のチャートを保存してください</td></tr>';
}

async function openTemplates() {
  templatesCache = await loadTemplates();
  renderTemplates();
  $('#tpl-error').textContent = '';
  $<HTMLInputElement>('#tpl-name').value = '';
  const dlg = $<HTMLDialogElement>('#tpl-dialog');
  if (!dlg.open) dlg.showModal();
}

function setupTemplates() {
  void loadTemplates().then((v) => (templatesCache = v));
  $('#templates-btn').addEventListener('click', () => void openTemplates());
  const fail = (e: unknown) => ($('#tpl-error').textContent = e instanceof Error ? e.message : String(e));
  $('#tpl-save').addEventListener('click', async () => {
    const name = $<HTMLInputElement>('#tpl-name').value.trim();
    if (!name) return void ($('#tpl-error').textContent = '定型の名前を入れてください');
    if (templatesCache.templates.some((t) => t.name === name) && !confirm(`「${name}」はもうあります。上書きしますか？`)) return;
    try {
      await saveTemplate(name, pickTemplate(state));
      templatesCache = await loadTemplates();
      renderTemplates();
      $<HTMLInputElement>('#tpl-name').value = '';
      toast(`定型「${name}」を保存しました`);
    } catch (e) {
      fail(e);
    }
  });
  $('#tpl-table').addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tpl]');
    if (!b) return;
    const name = b.dataset.name!;
    const t = templatesCache.templates.find((x) => x.name === name);
    if (!t) return;
    try {
      if (b.dataset.tpl === 'apply') {
        if (!confirm(`定型「${name}」をこのプロジェクトに当てますか？（並べ方・時間足・インジケーター・色などが置き換わります。検証と図形はそのまま）`)) return;
        state = applyTemplate(state, t.settings);
        $<HTMLDialogElement>('#tpl-dialog').close();
        // 並べ方やインジケーターを作り直すので、保存して読み直す
        await reloadInto(async () => {});
        return;
      }
      if (b.dataset.tpl === 'default') await setDefaultTemplate(templatesCache.default === name ? null : name);
      if (b.dataset.tpl === 'overwrite') {
        if (!confirm(`定型「${name}」を今のチャートの設定で上書きしますか？`)) return;
        await saveTemplate(name, pickTemplate(state));
      }
      if (b.dataset.tpl === 'delete') {
        if (!confirm(`定型「${name}」を削除しますか？`)) return;
        await deleteTemplate(name);
      }
      templatesCache = await loadTemplates();
      renderTemplates();
    } catch (err) {
      fail(err);
    }
  });
}

function setupProjects() {
  setupTemplates();
  const cur = currentMeta();
  renderProjectButton();
  const panel = $('#project-panel');
  $('#project').addEventListener('click', () => setProjectPanel(!!panel.hidden));
  panel.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    // フォルダの行のボタン・一番上のボタン
    const act = t.closest<HTMLButtonElement>('button[data-act]');
    if (act) {
      e.stopPropagation();
      void folderAction(act.dataset.act!, act.dataset.folder ?? '');
      return;
    }
    const b = t.closest<HTMLElement>('.pj-row');
    if (!b) return;
    if (b.dataset.folder !== undefined) {
      // フォルダを開く・閉じる
      const open = openFolders();
      const f = b.dataset.folder;
      if (open.has(f)) for (const x of [...open]) x === f || x.startsWith(`${f}/`) ? open.delete(x) : 0;
      else open.add(f);
      saveOpenFolders(open);
      renderProjectPanel();
      return;
    }
    const id = b.dataset.project!;
    setProjectPanel(false);
    if (id !== currentMeta().id) reloadInto(() => switchProject(id));
  });
  // ドラッグしてフォルダに落とすと移す
  panel.addEventListener('dragstart', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-project]');
    if (!row || !e.dataTransfer) return;
    e.dataTransfer.setData('text/x-fxp-project', row.dataset.project!);
    e.dataTransfer.effectAllowed = 'move';
  });
  const dropTarget = (e: DragEvent) => (e.target as HTMLElement).closest<HTMLElement>('.pj-drop');
  panel.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('text/x-fxp-project') || !dropTarget(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    panel.querySelectorAll('.pj-over').forEach((x) => x.classList.remove('pj-over'));
    dropTarget(e)!.classList.add('pj-over');
  });
  panel.addEventListener('dragleave', (e) => dropTarget(e)?.classList.remove('pj-over'));
  panel.addEventListener('drop', (e) => {
    const target = dropTarget(e);
    const id = e.dataTransfer?.getData('text/x-fxp-project');
    panel.querySelectorAll('.pj-over').forEach((x) => x.classList.remove('pj-over'));
    if (!target || !id) return;
    e.preventDefault();
    const folder = target.dataset.folder ?? '';
    const p = listProjects().find((x) => x.id === id);
    if (!p || (p.folder ?? '') === folder) return;
    setProjectFolder(id, folder).then(
      () => {
        if (folder) openFolder(folder);
        renderProjectPanel();
        renderProjectButton();
      },
      (err) => toast(err instanceof Error ? err.message : String(err)),
    );
  });
  document.addEventListener('mousedown', (e) => {
    const t = e.target as Node;
    if (!panel.hidden && !panel.contains(t) && !$('#project').contains(t)) setProjectPanel(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) setProjectPanel(false);
  });
  $('#project-menu').addEventListener('click', (ev) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    showMenu(r.left, r.bottom + 2, [
      // 今のプロジェクトと同じフォルダに作る
      ['新しいプロジェクト…', () => newProjectIn(currentMeta().folder)],
      [
        '名前を変更…',
        () => {
          const name = prompt('プロジェクトの名前', currentMeta().name);
          if (!name) return;
          renameProject(cur.id, name).then(renderProjectButton, (e) => toast(e instanceof Error ? e.message : String(e)));
        },
      ],
      [
        'フォルダに入れる…',
        () => {
          const used = [...new Set(listProjects().map((x) => x.folder).filter(Boolean))];
          const folder = prompt(
            `入れるフォルダの名前（空にするとフォルダから出します。「実トレード/2026」のように / で区切ると 2 段になります）${used.length ? `\n今あるフォルダ: ${used.join('、')}` : ''}`,
            currentMeta().folder ?? '',
          );
          if (folder === null) return;
          setProjectFolder(cur.id, folder).then(
            () => {
              renderProjectButton();
              toast(currentMeta().folder ? `「${currentMeta().folder}」に入れました` : 'フォルダから出しました');
            },
            (e) => toast(e instanceof Error ? e.message : String(e)),
          );
        },
      ],
      ['複製', () => reloadInto(() => createProject(`${currentMeta().name} のコピー`, structuredClone(state), currentMeta().folder))],
      [
        'ファイルに書き出す',
        () => {
          const blob = new Blob([exportProject(currentMeta().name, state)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${currentMeta().name}.fxp.json`;
          a.click();
          URL.revokeObjectURL(a.href);
        },
      ],
      ['ファイルから読み込む…', () => $('#project-file').click()],
      [
        'このプロジェクトを削除',
        () => {
          if (listProjects().length <= 1) return toast('最後のプロジェクトは削除できません');
          if (!confirm(`「${currentMeta().name}」を削除しますか？元に戻せません`)) return;
          // 消すプロジェクトは保存しない
          leaving = true;
          deleteProject(cur.id).then(
            () => location.reload(),
            (e) => {
              leaving = false;
              toast(e instanceof Error ? e.message : String(e));
            },
          );
        },
      ],
      ['保存先を表示', () => toast(storeInfo().remote ? `保存先: ${storeInfo().dir}` : '保存先のフォルダに届かないため、ブラウザの中だけに保存しています')],
    ]);
  });
  $<HTMLInputElement>('#project-file').addEventListener('change', async (ev) => {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const text = await file.text();
    await reloadInto(() => importProject(text));
  });
}

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
  test().ledger = undefined;
  state.symbol = symbol;
  // 固定スプレッドの検証なら、切り替え先の銘柄のスプレッドも決めておく（無ければ初期値）
  const sp = test().spreadPips;
  if (sp && sp[symbol] === undefined) sp[symbol] = DEFAULT_SPREAD_PIPS[symbol] ?? 0.5;
  await openSymbol(symbol, state.cursor);
  test().baseline.time = md.bid[cursor].t;
  freshRunner();
  renderChart(true);
  scrollToNow();
  refresh();
}

/** 操作の対象のチャート（時間足・インジケーター・拡大縮小・←→ はこのチャートに効く） */
function setActivePane(p: ChartPane) {
  if (active === p) return;
  active = p;
  state.activePane = p.index;
  for (const x of panes) x.setActive(x === p && visiblePanes().length > 1);
  syncTfButtons();
  save();
}

function syncTfButtons() {
  document.querySelectorAll<HTMLButtonElement>('[data-tf]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tf === active.tf)));
}

/** 時間足を変えたときに保った右端の時刻（長い時間足を通っても、元の細かい時刻に戻れるように） */
const tfAnchor = new WeakMap<ChartPane, number>();

function setTf(tf: Timeframe) {
  // 見ていた場所（右端の時刻）を保つ。最新の足を見ていたら、新しい時間足でも最新へ。
  // 週足・月足の右端は足の始まりの時刻しか分からないので、前に保った時刻がその足の中なら、そちらを使う
  // （月足で今月を見ていても「最新」ではなく、その中の前に保った時刻に戻る）
  let anchor = active.currentAnchor();
  const hint = tfAnchor.get(active);
  const base = active.anchorTime();
  if (hint !== undefined && base !== null && hint >= base && hint < base + (active.tf === 'MN' ? 31 * 1440 : TIMEFRAMES[active.tf]) * 60_000) anchor = hint;
  if (anchor === null) tfAnchor.delete(active);
  else tfAnchor.set(active, anchor);
  active.tf = tf;
  paneState(active).tf = tf;
  // インジケーターは時間足ごと。その時間足の設定に切り替える
  active.indicators.setConfig(indicatorsFor(tf));
  syncTfButtons();
  active.renderAt(anchor);
  renderQuotes();
  save();
  void ensureIndicatorHistory();
}

function setLayout(layout: Layout) {
  state.layout = layout;
  chartsEl.className = `layout-${layout}`;
  const n = LAYOUT_PANES[layout];
  panes.forEach((p, i) => (p.el.hidden = i >= n));
  if (active.el.hidden) setActivePane(panes[0]);
  for (const x of panes) x.setActive(x === active && n > 1);
  $<HTMLSelectElement>('#layout').value = layout;
  renderChart(true);
  scrollToNow();
  renderQuotes();
  save();
  void ensureIndicatorHistory();
}

/** チャートを 4 枚作る（表示するのは並べ方の枚数だけ） */
function createPanes() {
  const host: PaneHost = {
    agg: getAgg,
    dataVersion: () => dataVersion,
    cursor: () => cursor,
    bid: () => md.bid,
    toChart,
    symbol: () => md.symbol,
    digits: () => md.digits,
    activate: setActivePane,
    nearLeftEdge: loadEarlier,
    lead: (p) => (leader = p),
    holdCrosshair: (on) => setCrosshair(on),
    pip: () => spec.pip,
    rangeChanged: (p) => {
      // チャートはいつも連動する。マウスで動かしているチャートにだけ、ほかを合わせる（合わせた側の動きでは何もしない）
      if (p !== leader || p.el.hidden) return;
      const t = p.anchorTime();
      if (t === null) return;
      for (const x of visiblePanes()) if (x !== p) x.alignTo(t);
    },
    setRightOffset: (bars) => {
      state.rightOffset = bars;
      for (const p of panes) p.setRightOffset(bars);
      save();
    },
  };
  panes = state.panes!.map((ps, i) => {
    const el = document.createElement('div');
    el.className = 'pane';
    chartsEl.append(el);
    const p = new ChartPane(i, el, host, ps.tf, indicatorsFor(ps.tf));
    p.overlay.onEdit = onLineEdit;
    p.drawings.colorOf = (d) => (d.tf ? (state.tfColors?.[d.tf] ?? DEFAULT_TF_COLORS[d.tf] ?? d.color) : d.color);
    p.drawings.levelsOf = levelsOf;
    p.drawings.onEditLevels = () => openLevelsDialog();
    p.setRightOffset(state.rightOffset ?? 12);
    return p;
  });
  active = panes[Math.min(state.activePane ?? 0, panes.length - 1)];
  // 開発中の調査用（本番のビルドには入らない）
  if (import.meta.env.DEV) Object.assign(window, { __fx: { panes, active: () => active } });
}

/** 隠していない時間足（ツールバーと「1 つ長い・短い時間足」のキーで使う） */
function shownTfs(): Timeframe[] {
  return (Object.keys(TIMEFRAMES) as Timeframe[]).filter((tf) => !state.hiddenTfs?.includes(tf));
}

function showTfButtons() {
  document.querySelectorAll<HTMLButtonElement>('#timeframes [data-tf]').forEach((b) => (b.hidden = !!state.hiddenTfs?.includes(b.dataset.tf!)));
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
  // 右クリックで、ツールバーに出す時間足を選ぶ（使わない時間足を隠す）
  tfBar.title = '右クリックで、表示する時間足を選べます';
  showTfButtons();
  const tfMenu = (x: number, y: number) =>
    showMenu(
      x,
      y,
      (Object.keys(TIMEFRAMES) as Timeframe[]).map((tf) => [
        `${state.hiddenTfs?.includes(tf) ? '　' : '✓'} ${tf}`,
        () => {
          const hidden = new Set(state.hiddenTfs ?? []);
          if (hidden.has(tf)) hidden.delete(tf);
          else if (hidden.size < Object.keys(TIMEFRAMES).length - 1) hidden.add(tf);
          state.hiddenTfs = [...hidden];
          showTfButtons();
          save();
          tfMenu(x, y); // 続けて選べるように開いたままにする
        },
      ]),
    );
  tfBar.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    tfMenu(e.clientX, e.clientY);
  });

  // 図形はすべてのチャートで共通（どのチャートに描いても全部に出る）
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) =>
    b.addEventListener('click', () => {
      const tool = (b.dataset.tool || null) as DrawingKind | null;
      for (const p of panes) p.drawings.setTool(tool);
    }),
  );
  const showTool = (tool: DrawingKind | null) =>
    document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.tool || null) === tool)));
  for (const p of panes) {
    p.drawings.onToolChange = (tool) => {
      // 1 枚で描き終えたら、ほかのチャートのツールも戻す
      if (tool === null) for (const x of panes) if (x.drawings.tool !== null) x.drawings.setTool(null);
      showTool(tool);
    };
    p.drawings.onChange = () => {
      state.drawings[md.symbol] = p.drawings.drawings;
      for (const x of panes) {
        if (x === p) continue;
        x.drawings.drawings = p.drawings.drawings;
        x.drawings.refresh();
      }
      save();
    };
  }
  showTool(null);
  $('#clear-drawings').addEventListener('click', () => {
    if (active.drawings.drawings.length && confirm(`${md.symbol.toUpperCase()} の図形をすべて消しますか？`)) active.drawings.clearAll();
  });

  $('#zoom-in').addEventListener('click', () => active.zoom(1.25));
  $('#zoom-out').addEventListener('click', () => active.zoom(0.8));
  $('#toggle-history').addEventListener('click', (e) => {
    const on = !panes[0].overlay.showHistory;
    for (const p of panes) p.overlay.showHistory = on;
    (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(on));
    renderQuotes();
  });
  // ワンクリック注文（SELL・BUY とロット）を出す・隠す。隠してもロットの値は新規注文などで使う
  const showOneClick = () => {
    $('#oneclick').hidden = !!state.hideOneClick;
    $('#toggle-oneclick').setAttribute('aria-pressed', String(!state.hideOneClick));
  };
  showOneClick();
  $('#toggle-oneclick').addEventListener('click', () => {
    state.hideOneClick = !state.hideOneClick;
    showOneClick();
    save();
  });
  $<HTMLSelectElement>('#layout').addEventListener('change', (e) => setLayout((e.target as HTMLSelectElement).value as Layout));
  // 最新の足（今の時刻）が右端に来るように全部のチャートを動かす。拡大率はそのまま（MT4 の End キーと同じ）
  $('#to-now').addEventListener('click', () => scrollToNow());
  $('#zoom-reset').addEventListener('click', () => {
    for (const p of visiblePanes()) p.resetZoom();
  });

  const zoneEl = $<HTMLSelectElement>('#zone');
  zoneEl.addEventListener('change', () => {
    state.zone = zoneEl.value as DisplayZone;
    dataChanged();
    renderChart(true, false);
    scrollToNow();
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
    if (!row) return;
    if (row.dataset.kind === 'mt4') jumpToTrade(Number(row.dataset.ticket));
    else if (row.dataset.kind === 'history') showHistoryTrade(Number(row.dataset.ticket), Number(row.dataset.close));
    else openModifyDialog(Number(row.dataset.ticket));
  });
  termBody.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    const action = target?.dataset.action;
    // 行の右端の ✕: ポジションは全部決済、待機注文は削除
    if (action === 'close') act({ kind: 'close', ticket: Number(target!.dataset.ticket) });
    if (action === 'cancel') act({ kind: 'cancel', ticket: Number(target!.dataset.ticket) });
    if (action === 'mt4-load') $('#mt4-file').click();
    if (action === 'stats-src') {
      state.statsSource = target!.dataset.src as 'virtual' | 'mt4';
      renderTerminal(true);
      save();
    }
    if (action === 'export-csv') exportStats('csv');
    if (action === 'export-html') exportStats('html');
    if (action === 'mt4-clear' && confirm('読み込んだ MT4 の履歴を消しますか？')) {
      state.mt4 = null;
      mt4EventCache = null;
      refresh();
      renderTerminal(true);
    }
  });
  $<HTMLInputElement>('#mt4-file').addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) loadMt4File(file).catch((err) => toast(`読み込めませんでした: ${err instanceof Error ? err.message : err}`));
  });

  $('#indicators-btn').addEventListener('click', () => openIndicatorDialog());
  $('#tf-colors-btn').addEventListener('click', () => openColorDialog(state.tfColors ?? {}));
  $('#color-reset').addEventListener('click', () => openColorDialog({}));
  $('#color-apply').addEventListener('click', () => {
    const colors: Record<string, string> = {};
    document.querySelectorAll<HTMLInputElement>('#color-table input[data-tf]').forEach((el) => (colors[el.dataset.tf!] = el.value));
    state.tfColors = colors;
    for (const p of panes) p.drawings.refresh();
    $<HTMLDialogElement>('#color-dialog').close();
    save();
  });
  $('#keys-btn').addEventListener('click', () => openKeysDialog());
  $('#keys-reset').addEventListener('click', () => openKeysDialog(resolveKeymap(undefined)));
  $('#keys-apply').addEventListener('click', () => {
    state.keymap = keyDraft;
    keyIndex = commandIndex(resolveKeymap(keyDraft));
    $<HTMLDialogElement>('#keys-dialog').close();
    save();
  });
  $('#keys-table').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.key-slot');
    if (!b) return;
    keyWaiting = { id: b.dataset.id!, slot: Number(b.dataset.slot) };
    renderKeysDialog();
  });
  const keysDlg = $<HTMLDialogElement>('#keys-dialog');
  // 枠を作り直すとフォーカスが外れるので、ページ全体で先に受け取る
  window.addEventListener(
    'keydown',
    (e) => {
      if (!keysDlg.open || !keyWaiting) return;
      e.preventDefault();
      e.stopPropagation();
      // Esc はやめる、Delete・Backspace は空にする
      if (e.key === 'Escape') {
        keyWaiting = null;
        renderKeysDialog();
      } else if (e.key === 'Delete' || e.key === 'Backspace') assignKey(null);
      else {
        const k = keyOf(e);
        if (k) assignKey(k);
        else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) renderKeysDialog(`${e.metaKey ? '⌘ の付いたキー' : e.key} は使えません`);
      }
    },
    true,
  );
  // キーを待っている間の Esc でダイアログを閉じない
  keysDlg.addEventListener('cancel', (e) => {
    if (keyWaiting) e.preventDefault();
  });
  $('#fibo-levels-btn').addEventListener('click', () => openLevelsDialog());
  $('#levels-reset').addEventListener('click', () => openLevelsDialog((k) => DEFAULT_LEVELS[k]));
  $('#levels-apply').addEventListener('click', applyLevelsDialog);
  // 入力中の Enter は「適用」（何もしないとキャンセルで閉じてしまう）
  $('#levels-dialog').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || (e.target as HTMLElement).tagName !== 'INPUT') return;
    e.preventDefault();
    applyLevelsDialog();
  });
  $('#levels-dialog').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    if (b.classList.contains('levels-add')) {
      const table = $(`#levels-${b.dataset.kind}`);
      table.insertAdjacentHTML('beforeend', levelRow(''));
      [...table.querySelectorAll<HTMLInputElement>('input')].pop()?.focus();
    } else if (b.closest('td')) b.closest('tr')?.remove();
  });
  $('#ind-reset').addEventListener('click', () => openIndicatorDialog(structuredClone(DEFAULT_INDICATORS)));
  $('#ind-apply').addEventListener('click', () => {
    applyIndicators([active.tf], readIndicatorDialog());
    $<HTMLDialogElement>('#ind-dialog').close();
  });
  $('#ind-copy-all').addEventListener('click', () => {
    if (!confirm(`この設定を M1〜MN のすべての時間足に使いますか？（ほかの時間足の今の設定は上書きされます）`)) return;
    applyIndicators(Object.keys(TIMEFRAMES), readIndicatorDialog());
    $<HTMLDialogElement>('#ind-dialog').close();
  });
  termBody.addEventListener('contextmenu', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('tr[data-ticket]');
    if (!row || row.dataset.kind === 'history' || row.dataset.kind === 'mt4') return;
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
  // 別のアプリに切り替えたときもすぐ書く（閉じる直前の分がファイルに届かないことがあるため）
  document.addEventListener('visibilitychange', () => document.hidden && save(true));
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
  // 途中の約定も計算しながら、その日時まで進む・戻る
  await travel(t);
}

/** キーボードのショートカット（「ショートカット」の画面で変えられる。src/ui/keys.ts） */
let keyIndex = commandIndex(resolveKeymap(undefined));

function runCommand(id: string) {
  if (id.startsWith('tf:')) return setTf(id.slice(3) as Timeframe);
  if (id.startsWith('tool:')) return toggleTool(id.slice(5) as DrawingKind);
  switch (id) {
    case 'play':
      return setPlaying(!playing);
    case 'fwd':
      return stepBar(1);
    case 'back':
      return stepBar(-1);
    case 'fwdMin':
      return goTo(cursor + 1);
    case 'backMin':
      return goTo(cursor - 1);
    case 'tfUp':
    case 'tfDown': {
      // 隠した時間足は飛ばす（今の時間足が隠したものでも、その前後の表示している時間足へ）
      const all = Object.keys(TIMEFRAMES) as Timeframe[];
      const now = all.indexOf(active.tf);
      const shown = shownTfs();
      const next = id === 'tfUp' ? shown.find((tf) => all.indexOf(tf) > now) : shown.reverse().find((tf) => all.indexOf(tf) < now);
      return next && setTf(next);
    }
    case 'zoomIn':
      return active.zoom(1.25);
    case 'zoomOut':
      return active.zoom(0.8);
    case 'zoomReset':
      for (const p of visiblePanes()) p.resetZoom();
      return;
    case 'toNow':
      return scrollToNow();
    case 'crosshair':
      return setCrosshair(!crosshairOn);
    case 'newOrder':
      return openOrderDialog();
  }
}

/** 描画ツールを選ぶ。もう一度押すとやめる */
function toggleTool(tool: DrawingKind) {
  const next = panes[0].drawings.tool === tool ? null : tool;
  for (const p of panes) p.drawings.setTool(next);
}

function onKey(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || document.querySelector('dialog[open]')) return;
  // ⌘C（コピー）などは keyOf が null を返すので邪魔しない
  const k = keyOf(e);
  const cmd = k && keyIndex.get(k);
  if (cmd) {
    runCommand(cmd);
    e.preventDefault();
    return;
  }
  switch (e.key) {
    case 'Delete':
    case 'Backspace':
      if (!panes.some((p) => p.drawings.deleteSelected())) return;
      break;
    case 'Enter':
      // 描いている途中のポリラインを終える
      if (!panes.some((p) => p.drawings.finishPoly())) return;
      break;
    case 'Escape':
      setCrosshair(false);
      for (const p of panes) p.drawings.setTool(null);
      for (const p of panes) p.overlay.setHighlight(null);
      ctxMenu.hidden = true;
      return;
    default:
      return;
  }
  e.preventDefault();
}

// ---------------- 起動 ----------------
async function start() {
  const store = await initStore();
  state = { ...defaultState(), ...loadState() };
  keyIndex = commandIndex(resolveKeymap(state.keymap));
  migratePanes();
  createPanes();
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

  // 前回の続きなら、今の時刻の辺りを読み込む（口座は保存した区切りから計算するので、検証の最初まで読まなくてよい）
  const resume = state.test && state.cursor ? state.cursor : null;
  await openSymbol(state.symbol, resume);

  setupControls();
  setupProjects();
  setupEasyOrder();
  $<HTMLSelectElement>('#zone').value = state.zone;
  speedEl.value = String(state.speed);
  $('#speed-label').textContent = speedLabel(SPEEDS[state.speed]);
  $<HTMLInputElement>('#pause-on-fill').checked = state.pauseOnFill;
  lotsEl.value = String(state.lots);
  setLayoutQuiet(state.layout ?? '1');

  if (!state.test || md.indexAtOrBefore(state.cursor) < 0) {
    // 初めて開いたとき: データの最後から 5 日前を開始時刻にする
    const startAt = md.bid[Math.max(0, md.bid.length - 1 - 5 * DAY_BARS)].t;
    await startTest(md.symbol, startAt, DEFAULT_BALANCE, DEFAULT_LEVERAGE, DEFAULT_SPREAD_PIPS[md.symbol] ?? 0.5);
  } else {
    cursor = md.indexAtOrBefore(state.cursor);
    await travel(state.cursor);
  }
  $<HTMLInputElement>('#jump').value = toLocalInput(md.bid[cursor].t, state.zone, rule);

  updateStatus(Math.round(performance.now()));
  // 表示が出てから、インジケーターに必要な過去のデータを裏で読み込む（R1 の 1 秒を守るため後回し）
  setTimeout(() => void ensureIndicatorHistory(), 0);
  if (store.lockedBy) toast(`このプロジェクトは別の Mac（${store.lockedBy}）でも開いているようです。同時に使うと Dropbox で競合コピーができます`);
  else if (!store.remote) toast('保存先のフォルダに届かないため、ブラウザの中だけに保存しています');
}

let firstPaintMs = 0;
function updateStatus(ms = firstPaintMs) {
  firstPaintMs = ms;
  const months = md.loadedMonths;
  const range = months.length ? `${months[0]}〜${months[months.length - 1]}` : '';
  // ツールバーが 1 行に収まるよう、ふだん出すのは TitanFX の足の最新と注意だけ。読み込んでいる範囲・表示までの時間（R1）はマウスを乗せると出る
  statusEl.textContent = manifest ? '' : '仮データ（npm run import-data で実データを入れてください）';
  const tips = [
    `${manifest ? md.symbol.toUpperCase() : '仮データ'} ${range} を読み込み中 / 表示まで ${ms} ms`,
    storeInfo().remote ? `プロジェクトの保存先: ${storeInfo().dir}` : 'プロジェクトはブラウザの中だけに保存しています',
  ];
  // MT4 から書き出した直近の足（server/mt4Bars.ts）
  const titan = manifest?.symbols[md.symbol]?.titan;
  if (titan) {
    statusEl.textContent += `TitanFX 〜${formatTime(titan.to, state.zone, rule).slice(5)}`;
    tips.push(`${formatTime(titan.from, state.zone, rule)} からは MT4（TitanFX）の 1 分足、それより前は Dukascopy`);
  }
  if (barsStatus) {
    tips.push(`MT4 の足の共有フォルダ: ${barsStatus.dir}${barsStatus.found ? '' : '（見つかりません）'}`);
    if (barsStatus.error) tips.push(`取り込みのエラー: ${barsStatus.error}`);
    const off = barsStatus.offset;
    if (off && off.mt4 !== off.app) {
      statusEl.textContent += ' ⚠ サーバー時刻';
      tips.push(`MT4 のサーバー時刻は GMT${off.mt4 >= 0 ? '+' : ''}${off.mt4 / 60} 時間、アプリの設定（NY+7）では GMT+${off.app / 60} 時間で合っていません。夏時間の決まりを見直してください（CLAUDE.md）`);
    }
  }
  statusEl.title = tips.join('\n');
}

// ---------------- MT4 の 1 分足（自動取り込み） ----------------
// 開発サーバーが共有フォルダから取り込んだ新しい足を、1 分ごとに見に行って後ろに足す。

interface BarsStatus {
  dir: string;
  found: boolean;
  error: string | null;
  latest: Record<string, number>;
  offset: { mt4: number; app: number; at: number } | null;
}
let barsStatus: BarsStatus | null = null;

async function pollBars() {
  try {
    const res = await fetch('/api/bars/status', { cache: 'no-store' });
    if (!res.ok || !res.headers.get('content-type')?.includes('json')) return;
    barsStatus = (await res.json()) as BarsStatus;
  } catch {
    return;
  }
  const mdNow = md;
  const latest = barsStatus.latest[md.symbol];
  const known = manifest?.symbols[md.symbol]?.titan?.to ?? -Infinity;
  if (manifest && latest && latest > known) {
    const m = await loadManifest();
    if (!m || md !== mdNow) return;
    manifest = m;
    const added = await md.appendLatest(m.symbols[md.symbol]?.months ?? []);
    if (usd && m.symbols.usdjpy) await usd.appendLatest(m.symbols.usdjpy.months);
    if (added > 0 && md === mdNow) {
      dataChanged();
      renderChart(false, true);
      refresh();
    }
  }
  updateStatus();
}

start()
  .then(() => {
    void pollBars();
    setInterval(() => void pollBars(), 60_000);
  })
  .catch((e) => {
    console.error(e);
    statusEl.textContent = `エラー: ${e instanceof Error ? e.message : e}`;
  });
