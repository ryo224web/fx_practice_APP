// 成績の分析。決済した取引の一覧から、次の検証に活かすための数字と内訳を作る。
// 仮想の取引と、読み込んだ MT4 の取引のどちらにも使う（どちらも TradeRecord にそろえてから渡す）。

export interface TradeRecord {
  ticket: number;
  side: 'buy' | 'sell';
  lots: number;
  /** UTC ミリ秒 */
  openTime: number;
  closeTime: number;
  openPrice: number;
  closePrice: number;
  /** 決済した時点の S/L・T/P（途中で動かしていれば動かした後の値） */
  sl: number | null;
  tp: number | null;
  /** 損益（円。スワップ・手数料を含む） */
  profit: number;
  /** 値幅（pips。勝ちがプラス） */
  pips: number;
  /** 決済の理由。分からなければ null */
  reason: 'sl' | 'tp' | 'manual' | null;
  /** 保有中に一番不利・有利だった値幅（pips）。価格データが無ければ null */
  mae: number | null;
  mfe: number | null;
}

export interface Bucket {
  label: string;
  trades: number;
  wins: number;
  net: number;
  pips: number;
  winRate: number;
}

export interface Summary {
  trades: number;
  wins: number;
  losses: number;
  /** 損益ちょうど 0 */
  even: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  net: number;
  /** 初期資金に対する増減（%） */
  returnPct: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  /** 平均利益 ÷ 平均損失（リスクリワード） */
  payoff: number;
  expectancy: number;
  totalPips: number;
  avgPips: number;
  avgWinPips: number;
  avgLossPips: number;
  maxWin: number;
  maxLoss: number;
  maxConsecWins: number;
  maxConsecLosses: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  /** 純損益 ÷ 最大ドローダウン */
  recoveryFactor: number;
  /** 保有時間（分） */
  avgHold: number;
  avgHoldWin: number;
  avgHoldLoss: number;
  maxHold: number;
  minHold: number;
  slHits: number;
  tpHits: number;
  manual: number;
  /** 決済時の S/L を 1R とした損益の平均（S/L のある取引だけ） */
  avgR: number;
  rTrades: number;
  avgMae: number;
  avgMfe: number;
  /** 取引した期間（最初のエントリー〜最後の決済、日） */
  days: number;
  tradesPerDay: number;
}

export interface Analysis {
  summary: Summary;
  long: Summary;
  short: Summary;
  /** 決済ごとの残高（最初は初期資金） */
  equity: { t: number; balance: number; drawdown: number }[];
  trades: TradeRecord[];
  byWeekday: Bucket[];
  byHour: Bucket[];
  bySession: Bucket[];
  byMonth: Bucket[];
  byHold: Bucket[];
  /** pips の分布（10 pips 刻み） */
  pipsHistogram: Bucket[];
  insights: string[];
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
/** 日本時間での市場の時間帯（重なりがあるので、エントリーした時刻で一番近いものに入れる） */
const SESSIONS: { label: string; from: number; to: number }[] = [
  { label: 'オセアニア（5〜9時）', from: 5, to: 9 },
  { label: '東京（9〜15時）', from: 9, to: 15 },
  { label: '欧州（15〜21時）', from: 15, to: 21 },
  { label: 'NY（21〜翌5時）', from: 21, to: 29 },
];
const HOLD_BUCKETS: { label: string; max: number }[] = [
  { label: '15 分未満', max: 15 },
  { label: '15 分〜1 時間', max: 60 },
  { label: '1〜4 時間', max: 240 },
  { label: '4〜24 時間', max: 1440 },
  { label: '1 日以上', max: Infinity },
];

function emptySummary(): Summary {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    even: 0,
    winRate: NaN,
    grossProfit: 0,
    grossLoss: 0,
    net: 0,
    returnPct: NaN,
    profitFactor: NaN,
    avgWin: NaN,
    avgLoss: NaN,
    payoff: NaN,
    expectancy: NaN,
    totalPips: 0,
    avgPips: NaN,
    avgWinPips: NaN,
    avgLossPips: NaN,
    maxWin: 0,
    maxLoss: 0,
    maxConsecWins: 0,
    maxConsecLosses: 0,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    recoveryFactor: NaN,
    avgHold: NaN,
    avgHoldWin: NaN,
    avgHoldLoss: NaN,
    maxHold: NaN,
    minHold: NaN,
    slHits: 0,
    tpHits: 0,
    manual: 0,
    avgR: NaN,
    rTrades: 0,
    avgMae: NaN,
    avgMfe: NaN,
    days: 0,
    tradesPerDay: NaN,
  };
}

/**
 * 決済した時点の S/L までの値幅を 1R とした損益。S/L が無い・建値と同じか有利な側にある
 * （建値に動かした・利益を確保した）取引は、リスクが決まらないので null
 */
export function rMultiple(t: TradeRecord): number | null {
  if (t.sl === null) return null;
  const dir = t.side === 'buy' ? 1 : -1;
  const risk = (t.openPrice - t.sl) * dir;
  if (!(risk > t.openPrice * 1e-6)) return null;
  return ((t.closePrice - t.openPrice) * dir) / risk;
}

/**
 * 保有中に一番不利・有利だった値幅（pips）。i0・i1 は建てた足・決済した足の位置。
 * 買いは Bid、売りは Ask で見る（決済に使う側）。
 * - 成行（足の終値で約定）なら、建てた足の値動きは約定より前なので含めない
 * - 建てた足・決済した足のそれ以外の部分は 1 分足全体で見る（少し大きめに出ることがある）
 * - 同じ 1 分足の中で終わった取引は、足の中の順番が分からないので決済の値幅だけを使う
 * 含み損は 0 以下、含み益は 0 以上にし、決済した値幅も含める
 */
export function excursionOf(
  bid: readonly { h: number; l: number; c: number }[],
  ask: readonly { h: number; l: number; c: number }[],
  i0: number,
  i1: number,
  side: 'buy' | 'sell',
  openPrice: number,
  closePrice: number,
  pip: number,
): { mae: number; mfe: number } {
  const dir = side === 'buy' ? 1 : -1;
  const done = ((closePrice - openPrice) * dir) / pip;
  if (i0 >= i1) return { mae: Math.min(0, done), mfe: Math.max(0, done) };
  const entryBar = side === 'buy' ? ask[i0] : bid[i0];
  const from = Math.abs(entryBar.c - openPrice) < pip * 0.01 ? i0 + 1 : i0;
  const bars = side === 'buy' ? bid : ask;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = from; i <= i1; i++) {
    if (bars[i].h > hi) hi = bars[i].h;
    if (bars[i].l < lo) lo = bars[i].l;
  }
  const a = (((side === 'buy' ? lo : hi) - openPrice) * dir) / pip;
  const f = (((side === 'buy' ? hi : lo) - openPrice) * dir) / pip;
  return { mae: Math.min(0, a, done), mfe: Math.max(0, f, done) };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const holdMin = (t: TradeRecord) => (t.closeTime - t.openTime) / 60_000;

export function summarize(trades: readonly TradeRecord[], initialBalance: number, pip: number): Summary {
  const s = emptySummary();
  const list = trades.slice().sort((a, b) => a.closeTime - b.closeTime);
  s.trades = list.length;
  if (!list.length) return s;
  const wins = list.filter((t) => t.profit > 0);
  const losses = list.filter((t) => t.profit < 0);
  s.wins = wins.length;
  s.losses = losses.length;
  s.even = list.length - wins.length - losses.length;
  s.winRate = (wins.length / list.length) * 100;
  s.grossProfit = wins.reduce((a, t) => a + t.profit, 0);
  s.grossLoss = losses.reduce((a, t) => a + t.profit, 0);
  s.net = s.grossProfit + s.grossLoss;
  s.returnPct = initialBalance > 0 ? (s.net / initialBalance) * 100 : NaN;
  s.profitFactor = s.grossLoss < 0 ? s.grossProfit / -s.grossLoss : s.grossProfit > 0 ? Infinity : NaN;
  s.avgWin = avg(wins.map((t) => t.profit));
  s.avgLoss = avg(losses.map((t) => t.profit));
  s.payoff = s.avgLoss < 0 ? s.avgWin / -s.avgLoss : NaN;
  s.expectancy = s.net / list.length;
  s.totalPips = list.reduce((a, t) => a + t.pips, 0);
  s.avgPips = s.totalPips / list.length;
  s.avgWinPips = avg(wins.map((t) => t.pips));
  s.avgLossPips = avg(losses.map((t) => t.pips));
  s.maxWin = Math.max(0, ...list.map((t) => t.profit));
  s.maxLoss = Math.min(0, ...list.map((t) => t.profit));

  let cw = 0;
  let cl = 0;
  let balance = initialBalance;
  let peak = initialBalance;
  for (const t of list) {
    if (t.profit > 0) {
      cw++;
      cl = 0;
    } else if (t.profit < 0) {
      cl++;
      cw = 0;
    }
    s.maxConsecWins = Math.max(s.maxConsecWins, cw);
    s.maxConsecLosses = Math.max(s.maxConsecLosses, cl);
    balance += t.profit;
    peak = Math.max(peak, balance);
    const dd = peak - balance;
    if (dd > s.maxDrawdown) s.maxDrawdown = dd;
    // 初期資金が分からない（MT4 の履歴など）ときは % を出さない
    if (initialBalance > 0 && peak > 0 && (dd / peak) * 100 > s.maxDrawdownPct) s.maxDrawdownPct = (dd / peak) * 100;
  }
  if (!(initialBalance > 0)) s.maxDrawdownPct = NaN;
  s.recoveryFactor = s.maxDrawdown > 0 ? s.net / s.maxDrawdown : NaN;

  const holds = list.map(holdMin);
  s.avgHold = avg(holds);
  s.avgHoldWin = avg(wins.map(holdMin));
  s.avgHoldLoss = avg(losses.map(holdMin));
  s.maxHold = Math.max(...holds);
  s.minHold = Math.min(...holds);
  s.slHits = list.filter((t) => t.reason === 'sl').length;
  s.tpHits = list.filter((t) => t.reason === 'tp').length;
  s.manual = list.filter((t) => t.reason === 'manual').length;

  const rs = list.map(rMultiple).filter((r): r is number => r !== null);
  s.rTrades = rs.length;
  s.avgR = avg(rs);
  s.avgMae = avg(list.filter((t) => t.mae !== null).map((t) => t.mae!));
  s.avgMfe = avg(list.filter((t) => t.mfe !== null).map((t) => t.mfe!));

  const first = Math.min(...list.map((t) => t.openTime));
  const last = Math.max(...list.map((t) => t.closeTime));
  s.days = Math.max(1, (last - first) / 86_400_000);
  s.tradesPerDay = list.length / s.days;
  return s;
}

function bucketize(trades: readonly TradeRecord[], labels: string[], keyOf: (t: TradeRecord) => number): Bucket[] {
  const out = labels.map((label) => ({ label, trades: 0, wins: 0, net: 0, pips: 0, winRate: NaN }));
  for (const t of trades) {
    const b = out[keyOf(t)];
    if (!b) continue;
    b.trades++;
    if (t.profit > 0) b.wins++;
    b.net += t.profit;
    b.pips += t.pips;
  }
  for (const b of out) b.winRate = b.trades ? (b.wins / b.trades) * 100 : NaN;
  return out;
}

/**
 * @param toWall UTC → 表示する時刻帯（日本時間など）の壁時計の値（UTC 形式のミリ秒）。曜日・時間帯の内訳に使う
 */
export function analyze(trades: readonly TradeRecord[], initialBalance: number, pip: number, toWall: (utc: number) => number): Analysis {
  const list = trades.slice().sort((a, b) => a.closeTime - b.closeTime);
  const summary = summarize(list, initialBalance, pip);

  const equity: Analysis['equity'] = [];
  let balance = initialBalance;
  let peak = initialBalance;
  if (list.length) equity.push({ t: list[0].openTime, balance, drawdown: 0 });
  for (const t of list) {
    balance += t.profit;
    peak = Math.max(peak, balance);
    equity.push({ t: t.closeTime, balance, drawdown: peak - balance });
  }

  const wall = (t: number) => new Date(toWall(t));
  const byWeekday = bucketize(list, WEEKDAYS, (t) => wall(t.openTime).getUTCDay());
  const byHour = bucketize(
    list,
    Array.from({ length: 24 }, (_, h) => `${h}時`),
    (t) => wall(t.openTime).getUTCHours(),
  );
  const bySession = bucketize(
    list,
    SESSIONS.map((x) => x.label),
    (t) => {
      const h = wall(t.openTime).getUTCHours();
      const hh = h < 5 ? h + 24 : h;
      return SESSIONS.findIndex((x) => hh >= x.from && hh < x.to);
    },
  );
  const months = [...new Set(list.map((t) => wall(t.closeTime).toISOString().slice(0, 7)))].sort();
  const byMonth = bucketize(list, months, (t) => months.indexOf(wall(t.closeTime).toISOString().slice(0, 7)));
  const byHold = bucketize(
    list,
    HOLD_BUCKETS.map((b) => b.label),
    (t) => HOLD_BUCKETS.findIndex((b) => holdMin(t) < b.max),
  );

  // pips の分布（10 pips 刻み。端は -50 以下・+50 以上にまとめる）
  const edges = [-Infinity, -50, -40, -30, -20, -10, 0, 10, 20, 30, 40, 50, Infinity];
  const histLabels = edges.slice(0, -1).map((lo, i) => {
    const hi = edges[i + 1];
    if (lo === -Infinity) return `〜${hi}`;
    if (hi === Infinity) return `${lo}〜`;
    return `${lo}〜${hi}`;
  });
  const pipsHistogram = bucketize(list, histLabels, (t) => edges.findIndex((e, i) => t.pips >= e && t.pips < edges[i + 1]));

  return {
    summary,
    long: summarize(
      list.filter((t) => t.side === 'buy'),
      initialBalance,
      pip,
    ),
    short: summarize(
      list.filter((t) => t.side === 'sell'),
      initialBalance,
      pip,
    ),
    equity,
    trades: list,
    byWeekday,
    byHour,
    bySession,
    byMonth,
    byHold,
    pipsHistogram,
    insights: insights(list, summary, { byWeekday, bySession, byHold }),
  };
}

const n0 = (v: number) => Math.round(v).toLocaleString('ja-JP');
const n1 = (v: number) => v.toFixed(1);

/** 数字から読み取れる事実（良し悪しの判断ではなく、振り返りのきっかけになる事実だけ） */
function insights(list: readonly TradeRecord[], s: Summary, b: { byWeekday: Bucket[]; bySession: Bucket[]; byHold: Bucket[] }): string[] {
  const out: string[] = [];
  if (list.length < 5) {
    if (list.length) out.push(`取引が ${list.length} 回なので、内訳の数字はまだ偏りが大きいです（目安として 30 回以上）`);
    return out;
  }
  if (Number.isFinite(s.payoff)) {
    // 損益が 0 になる勝率 = 1 / (1 + リスクリワード)
    const be = (1 / (1 + s.payoff)) * 100;
    out.push(`平均利益は平均損失の ${s.payoff.toFixed(2)} 倍。この比率なら勝率 ${n1(be)}% で損益ゼロ（今の勝率は ${n1(s.winRate)}%）`);
  }
  const losers = list.filter((t) => t.profit < 0 && t.mfe !== null);
  if (losers.length) {
    const wentGreen = losers.filter((t) => t.mfe! >= 10).length;
    out.push(`負けた ${losers.length} 回のうち ${wentGreen} 回（${n1((wentGreen / losers.length) * 100)}%）は、一度 +10 pips 以上の含み益があった`);
  }
  const winners = list.filter((t) => t.profit > 0 && t.mfe !== null);
  if (winners.length) {
    const left = avg(winners.map((t) => t.mfe! - t.pips));
    out.push(`勝った取引では、最大の含み益から平均 ${n1(left)} pips 戻ったところで決済している`);
  }
  if (Number.isFinite(s.avgHoldWin) && Number.isFinite(s.avgHoldLoss)) {
    out.push(`平均の保有時間: 勝ち ${n0(s.avgHoldWin)} 分 / 負け ${n0(s.avgHoldLoss)} 分`);
  }
  const pick = (bs: Bucket[], name: string) => {
    const used = bs.filter((x) => x.trades >= 3);
    if (used.length < 2) return;
    const best = used.reduce((a, x) => (x.net > a.net ? x : a));
    const worst = used.reduce((a, x) => (x.net < a.net ? x : a));
    if (best !== worst) out.push(`${name}: 一番良いのは ${best.label}（${n0(best.net)} 円・${best.trades} 回）、一番悪いのは ${worst.label}（${n0(worst.net)} 円・${worst.trades} 回）`);
  };
  pick(b.byWeekday, '曜日');
  pick(b.bySession, '時間帯');
  pick(b.byHold, '保有時間');
  if (s.slHits + s.tpHits + s.manual > 0) {
    out.push(`決済の内訳: S/L ${s.slHits} 回・T/P ${s.tpHits} 回・手動 ${s.manual} 回`);
  }
  return out;
}

/** CSV（Excel で開けるように、先頭に BOM を付ける） */
export function tradesCsv(
  list: readonly TradeRecord[],
  time: (t: number) => string,
  digits: number,
  pip: number,
  toWall: (utc: number) => number,
): string {
  const head = [
    '注文番号',
    '方向',
    '数量',
    'エントリー時刻',
    'エントリー価格',
    '決済時刻',
    '決済価格',
    'S/L',
    'T/P',
    '決済の理由',
    'pips',
    '損益（円）',
    '保有時間（分）',
    'R（決済時のS/L基準）',
    '最大の含み損（pips）',
    '最大の含み益（pips）',
    '曜日',
  ];
  const reason = { sl: 'S/L', tp: 'T/P', manual: '手動' } as const;
  const rows = list.map((t) => [
    t.ticket,
    t.side === 'buy' ? '買い' : '売り',
    t.lots.toFixed(2),
    time(t.openTime),
    t.openPrice.toFixed(digits),
    time(t.closeTime),
    t.closePrice.toFixed(digits),
    t.sl === null ? '' : t.sl.toFixed(digits),
    t.tp === null ? '' : t.tp.toFixed(digits),
    t.reason ? reason[t.reason] : '',
    t.pips.toFixed(1),
    Math.round(t.profit),
    Math.round(holdMin(t)),
    rMultiple(t)?.toFixed(2) ?? '',
    t.mae === null ? '' : t.mae.toFixed(1),
    t.mfe === null ? '' : t.mfe.toFixed(1),
    WEEKDAYS[new Date(toWall(t.openTime)).getUTCDay()],
  ]);
  return '﻿' + [head, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n';
}
