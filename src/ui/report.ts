// 成績レポート（成績タブの中身と、書き出す HTML ファイル）

import type { Analysis, Bucket, Summary } from '../trade/analysis';
import { barChart, CHART_CSS, equityChart } from './charts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const ok = (v: number) => Number.isFinite(v);
const yen = (v: number) => (ok(v) ? `${(Math.round(v) || 0).toLocaleString('ja-JP')} 円` : '—');
const num = (v: number, d = 0) => (ok(v) ? v.toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d }) : v === Infinity ? '∞' : '—');
const pct = (v: number) => (ok(v) ? `${v.toFixed(1)}%` : '—');
const pips = (v: number) => (ok(v) ? `${v.toFixed(1)} pips` : '—');
const mins = (v: number) => {
  if (!ok(v)) return '—';
  if (v < 60) return `${Math.round(v)} 分`;
  if (v < 1440) return `${(v / 60).toFixed(1)} 時間`;
  return `${(v / 1440).toFixed(1)} 日`;
};
const cls = (v: number) => (ok(v) && v < 0 ? 'neg' : ok(v) && v > 0 ? 'pos' : '');

export interface ReportInfo {
  /** 「仮想の取引」「MT4 の履歴」 */
  sourceLabel: string;
  symbolLabel: string;
  /** 初期資金が分かっているか（分からなければ % は出さない） */
  hasBalance: boolean;
}

type Tone = 'high' | 'low' | 'case';
const BADGE: Record<Tone, string> = { high: '高いほど良い', low: '低いほど良い', case: '状況による' };

/** 説明つきの表の 1 行: 名前・値・目安・説明 */
function row(label: string, value: string, tone: string, badge: Tone, note: string) {
  return `<tr><td>${label}</td><td class="num ${tone}">${value}</td><td><span class="badge ${badge}">${BADGE[badge]}</span></td><td class="note">${esc(note)}</td></tr>`;
}

function section(title: string, rows: string[]) {
  return `<tr class="section"><th colspan="4">${title}</th></tr>${rows.join('')}`;
}

/** 主な数字を、目安（高いほど良い・低いほど良い）と説明つきで並べる */
function explainedTable(s: Summary, info: ReportInfo): string {
  const perMonth = (v: number) => (s.months > 0 ? v / s.months : NaN);
  const one = s.months <= 1 ? '（1 か月分なので合計と同じ）' : `（${s.months} か月の平均）`;
  return `<table class="report-table explained"><tbody>${[
    section('トレード', [
      row('合計トレード', `${s.trades}`, '', 'case', '期間中に決済したトレードの数。多い・少ないに良し悪しはなく、取引の頻度を表す'),
      row('勝ちトレード', `${s.wins}`, '', 'high', '損益がプラスで終わったトレードの数'),
      row('負けトレード', `${s.losses}`, '', 'low', `損益がマイナスで終わったトレードの数${s.even ? `（ちょうど 0 が ${s.even} 回）` : ''}`),
      row('連続勝ち', `${s.maxConsecWins}`, '', 'high', '一番長く続いた連勝の数'),
      row('連続負け', `${s.maxConsecLosses}`, '', 'low', '一番長く続いた連敗の数。大きいほど、資金が続けて減るリスクが高い'),
      row('トレード / 日', num(s.tradesPerDay, 2), '', 'case', '1 日あたりの平均の回数（最初のエントリーから最後の決済までの日数で割る）'),
      row('トレード / 月', num(perMonth(s.trades), 1), '', 'case', `1 か月あたりの回数${one}`),
      row('勝ちトレード / 月', num(perMonth(s.wins), 1), '', 'high', `1 か月あたりの勝ちの数${one}`),
      row('負けトレード / 月', num(perMonth(s.losses), 1), '', 'low', `1 か月あたりの負けの数${one}`),
      row('1 トレードの最大利益', yen(s.maxWin), 'pos', 'high', '一番利益が大きかったトレード。この 1 回に頼りすぎていないかも見る'),
      row('1 トレードの最大損失', yen(s.maxLoss), 'neg', 'low', '一番損失が大きかったトレード（小さいほどリスクが低い）'),
    ]),
    section('収益', [
      row('純損益', yen(s.net), cls(s.net), 'high', '期間の損益の合計（スワップ・手数料込み）'),
      ...(info.hasBalance ? [row('初期資金からの増減', pct(s.returnPct), cls(s.returnPct), 'high', '純損益 ÷ 初期資金')] : []),
      row('総利益', yen(s.grossProfit), 'pos', 'high', '勝ちトレードの利益の合計'),
      row('総損失', yen(s.grossLoss), 'neg', 'low', '負けトレードの損失の合計（小さいほど良い）'),
      row('純損益 / 月', yen(perMonth(s.net)), cls(s.net), 'high', `1 か月あたりの純損益${one}`),
      row('平均利益', yen(s.avgWin), 'pos', 'high', '勝ちトレード 1 回あたりの利益'),
      row('平均損失', yen(s.avgLoss), 'neg', 'low', '負けトレード 1 回あたりの損失（小さいほど良い）'),
      row('期待値（1 回あたり）', yen(s.expectancy), cls(s.expectancy), 'high', '純損益 ÷ トレード数。1 回トレードするといくら増える（減る）か'),
      row('リスクリワード', num(s.payoff, 2), '', 'high', '平均利益 ÷ 平均損失。1 より大きければ、勝つときの方が大きい'),
      row('最大ドローダウン', `${yen(s.maxDrawdown)}${info.hasBalance ? `（${pct(s.maxDrawdownPct)}）` : ''}`, 'neg', 'low', '残高（累積の損益）が一番高い所から、どれだけ下がったかの最大'),
      row('プロフィットファクター', num(s.profitFactor, 2), '', 'high', '総利益 ÷ 総損失。1 未満は損失の方が多い。1.5 以上あると良いとされる'),
      row('利率 %', num(s.returnToDrawdownPct, 2), cls(s.returnToDrawdownPct), 'high', '純損益 ÷ 最大ドローダウン × 100。下げの大きさに対して、どれだけ増えたか'),
    ]),
    section('pips', [
      row('合計', pips(s.totalPips), cls(s.totalPips), 'high', '値幅の合計（勝ちがプラス）。銘柄が混ざっていると、銘柄ごとの 1 pip の大きさが違う'),
      row('平均', pips(s.avgPips), cls(s.avgPips), 'high', '1 トレードあたりの値幅'),
      row('勝ちの平均', pips(s.avgWinPips), 'pos', 'high', '勝ちトレードの平均の値幅'),
      row('負けの平均', pips(s.avgLossPips), 'neg', 'low', '負けトレードの平均の値幅（小さいほど良い）'),
      row('最大の含み益の平均（MFE）', pips(s.avgMfe), '', 'case', '保有中に一番有利だったときの値幅。今の銘柄で価格データがある取引だけ'),
      row('最大の含み損の平均（MAE）', pips(s.avgMae), '', 'case', '保有中に一番不利だったときの値幅。今の銘柄で価格データがある取引だけ'),
      row('平均 R', s.rTrades ? `${num(s.avgR, 2)} R（${s.rTrades} 回）` : '—', cls(s.avgR), 'high', '決済した時点の S/L までの値幅を 1R とした損益。S/L を建値や利益側に動かした取引は除く'),
    ]),
    section('その他・統計', [
      row('最大ロット', num(s.maxLots, 2), '', 'case', '使った一番大きいロット。資金管理のルールどおりかを見る'),
      row('リカバリーファクター', num(s.recoveryFactor, 2), cls(s.recoveryFactor), 'high', '純損益 ÷ 最大ドローダウン。下げからの回復の力の目安'),
      row('リライアビリティファクター', num(s.reliability, 2), cls(s.reliability), 'high', '（平均損益 ÷ 損益の標準偏差）× √トレード数。プラスで大きいほど、偶然ではなく勝てている目安（2 以上でかなり確か）'),
      row('勝率', pct(s.winRate), '', 'high', '勝ちトレードの割合。平均利益と平均損失の比とあわせて見る'),
      row('負け率', pct(s.trades ? (s.losses / s.trades) * 100 : NaN), '', 'low', '負けトレードの割合'),
      row('平均の保有時間', `${mins(s.avgHold)}（勝ち ${mins(s.avgHoldWin)} / 負け ${mins(s.avgHoldLoss)}）`, '', 'case', '建ててから決済するまでの時間'),
      row('決済の内訳', `S/L ${s.slHits} / T/P ${s.tpHits} / 手動 ${s.manual}`, '', 'case', '記録の価格が S/L・T/P と同じかで見分ける'),
    ]),
  ].join('')}</tbody></table>`;
}

function sideTable(a: Analysis): string {
  const rows: [string, (s: Summary) => string][] = [
    ['取引回数', (s) => `${s.trades}`],
    ['勝率', (s) => pct(s.winRate)],
    ['純損益', (s) => yen(s.net)],
    ['プロフィットファクター', (s) => num(s.profitFactor, 2)],
    ['期待値', (s) => yen(s.expectancy)],
    ['平均 pips', (s) => pips(s.avgPips)],
    ['平均の保有時間', (s) => mins(s.avgHold)],
  ];
  return `<table class="report-table"><thead><tr><th></th><th>買い</th><th>売り</th></tr></thead><tbody>${rows
    .map(([k, f]) => `<tr><td>${k}</td><td class="num">${f(a.long)}</td><td class="num">${f(a.short)}</td></tr>`)
    .join('')}</tbody></table>`;
}

function bucketTable(bs: Bucket[], head: string): string {
  const used = bs.filter((b) => b.trades > 0);
  if (!used.length) return '<p class="hint">データがありません</p>';
  return `<table class="report-table"><thead><tr><th>${head}</th><th>回数</th><th>勝率</th><th>損益</th><th>pips</th></tr></thead><tbody>${used
    .map(
      (b) =>
        `<tr><td>${esc(b.label)}</td><td class="num">${b.trades}</td><td class="num">${pct(b.winRate)}</td><td class="num ${cls(b.net)}">${yen(b.net)}</td><td class="num ${cls(b.pips)}">${b.pips.toFixed(1)}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

/** 週別・時間帯別などの表（買い・売りの内訳つき） */
function sideBucketTable(bs: Bucket[], head: string): string {
  const used = bs.filter((b) => b.trades > 0);
  if (!used.length) return '<p class="hint">データがありません</p>';
  const rate = (w: number, n: number) => (n ? pct((w / n) * 100) : '—');
  return `<table class="report-table"><thead><tr><th>${head}</th><th>回数</th><th>純損益</th><th>勝率</th><th>買い</th><th>買いの勝率</th><th>売り</th><th>売りの勝率</th></tr></thead><tbody>${used
    .map(
      (b) =>
        `<tr><td>${esc(b.label)}</td><td class="num">${b.trades}</td><td class="num ${cls(b.net)}">${yen(b.net)}</td><td class="num">${pct(b.winRate)}</td><td class="num">${b.longs}</td><td class="num">${rate(b.longWins, b.longs)}</td><td class="num">${b.shorts}</td><td class="num">${rate(b.shortWins, b.shorts)}</td></tr>`,
    )
    .join('')}</tbody></table>`;
}

const toBars = (bs: Bucket[]) => bs.map((b) => ({ label: b.label, value: b.net, note: `${b.trades} 回・勝率 ${pct(b.winRate)}` }));

/** 成績タブの一番上に置く、簡単な一覧（詳しいものはその下と、書き出したレポートで見る） */
export function quickSummary(s: Summary, info: ReportInfo): string {
  const it = (k: string, v: string, tone = '') => `<div class="stat"><span>${k}</span><b class="${tone}">${v}</b></div>`;
  return `<div class="stats quick">
    ${it('取引回数', `${s.trades}`)}${it('勝ち', `${s.wins}`)}${it('負け', `${s.losses}`)}${it('勝率', pct(s.winRate))}
    ${it('純損益', yen(s.net), cls(s.net))}${it('総利益', yen(s.grossProfit), 'pos')}${it('総損失', yen(s.grossLoss), 'neg')}${it('プロフィットファクター', num(s.profitFactor, 2))}
    ${it('平均利益', yen(s.avgWin), 'pos')}${it('平均損失', yen(s.avgLoss), 'neg')}${it('期待値（1 回あたり）', yen(s.expectancy), cls(s.expectancy))}${it('最大ドローダウン', `${yen(s.maxDrawdown)}${info.hasBalance ? `（${pct(s.maxDrawdownPct)}）` : ''}`, 'neg')}
    ${it('最大利益', yen(s.maxWin), 'pos')}${it('最大損失', yen(s.maxLoss), 'neg')}${it('最大連勝', `${s.maxConsecWins}`)}${it('最大連敗', `${s.maxConsecLosses}`)}
  </div>`;
}

/** レポートの本文（成績タブとファイルで共通） */
export function reportBody(a: Analysis, info: ReportInfo, initialBalance: number): string {
  const s = a.summary;
  if (!s.trades) return `<p class="hint">${esc(info.sourceLabel)}に、決済した取引がまだありません。</p>`;
  const card = (title: string, body: string, wide = false) => `<section class="card ${wide ? 'wide' : ''}"><h3>${title}</h3>${body}</section>`;
  return `<div class="report">
    ${card('気づき（数字から読み取れること）', a.insights.length ? `<ul class="insights">${a.insights.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="hint">取引が増えると表示します</p>', true)}
    ${card('残高の推移（薄い赤はドローダウン）', equityChart(a.equity, info.hasBalance ? initialBalance : 0), true)}
    ${card('主な数字（目安と説明つき）', explainedTable(s, info), true)}
    ${a.bySymbol.length > 1 ? card('銘柄別', sideBucketTable(a.bySymbol, '銘柄'), true) : ''}
    ${card('取引ごとの損益', barChart(a.trades.map((t, i) => ({ label: `${i + 1}`, value: t.profit, note: `#${t.ticket} ${t.side} ${t.pips.toFixed(1)} pips` }))), true)}
    ${card('pips の分布（回数）', barChart(a.pipsHistogram.map((b, i) => ({ label: b.label, value: b.trades, tone: i < 6 ? 'neg' : 'pos' })), { labelEvery: 2, unit: ' 回' }))}
    ${card('買い・売り別', sideTable(a))}
    ${card('曜日別の損益（エントリーした日）', barChart(toBars(a.byWeekday), { labelEvery: 1 }) + bucketTable(a.byWeekday, '曜日'))}
    ${card('週別（月曜始まり・エントリーした日）', sideBucketTable(a.byWeek, '週'), true)}
    ${card('時間帯別（エントリーした時刻）', barChart(toBars(a.bySession), { labelEvery: 1 }) + sideBucketTable(a.bySession, '時間帯'), true)}
    ${card('時刻別の損益（エントリーした時刻・1 時間ごと）', barChart(toBars(a.byHour), { labelEvery: 3 }), true)}
    ${card('保有時間別の損益', barChart(toBars(a.byHold), { labelEvery: 1 }) + bucketTable(a.byHold, '保有時間'))}
    ${card('月別', bucketTable(a.byMonth, '月'))}
  </div>`;
}

export const REPORT_CSS = `
.report { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; padding: 10px; }
.report .card { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--bg); min-width: 0; }
.report .card.wide { grid-column: 1 / -1; }
.report h3 { margin: 0 0 8px; font-size: 13px; }
.report h4 { margin: 0 0 4px; font-size: 12px; color: var(--muted); font-weight: 500; }
.report .insights { margin: 0; padding-left: 1.2em; line-height: 1.7; }
.report .stat-groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px 18px; }
.report .stat { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px solid var(--grid); padding: 2px 0; }
.report .stat span { color: var(--muted); }
.report .pos { color: var(--pos); }
.report .neg { color: var(--neg); }
.report .hint { color: var(--muted); }
.report-table { width: 100%; border-collapse: collapse; margin-top: 6px; font-variant-numeric: tabular-nums; }
.report-table th, .report-table td { padding: 2px 6px; border-bottom: 1px solid var(--grid); text-align: left; }
.report-table th { color: var(--muted); font-weight: 500; }
.report-table td.num { text-align: right; white-space: nowrap; }
.report-table.explained td:first-child { white-space: nowrap; }
.report-table.explained td.note { color: var(--muted); }
.report-table tr.section th { padding-top: 10px; color: var(--fg); font-weight: 600; }
.badge { display: inline-block; padding: 0 6px; border-radius: 4px; font-size: 11px; white-space: nowrap; background: var(--grid); color: var(--muted); }
.badge.high { color: var(--pos); }
.badge.low { color: var(--neg); }
${CHART_CSS}
`;

/** 書き出す HTML ファイル（これ 1 つで開ける） */
export function reportHtml(title: string, subtitle: string, body: string): string {
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
:root { --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --grid: #eef0f2; --border: #d0d7de; --accent: #0969da; --pos: #1a7f37; --neg: #cf222e; color-scheme: light dark; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --grid: #1c2128; --border: #30363d; --accent: #4493f8; --pos: #3fb950; --neg: #f85149; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.5 system-ui, -apple-system, 'Hiragino Sans', 'Yu Gothic UI', sans-serif; }
header { padding: 16px 20px 0; }
header h1 { margin: 0; font-size: 18px; }
header p { margin: 4px 0 0; color: var(--muted); }
${REPORT_CSS}
</style></head>
<body><header><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></header>${body}</body></html>`;
}
