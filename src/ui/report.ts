// 成績レポート（成績タブの中身と、書き出す HTML ファイル）

import type { Analysis, Bucket, Summary } from '../trade/analysis';
import { barChart, CHART_CSS, equityChart } from './charts';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const ok = (v: number) => Number.isFinite(v);
const yen = (v: number) => (ok(v) ? `${Math.round(v).toLocaleString('ja-JP')} 円` : '—');
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

function item(label: string, value: string, tone = '', hint = '') {
  return `<div class="stat" ${hint ? `title="${esc(hint)}"` : ''}><span>${label}</span><b class="${tone}">${value}</b></div>`;
}

function group(title: string, items: string[]) {
  return `<section class="stat-group"><h4>${title}</h4>${items.join('')}</section>`;
}

function summaryGroups(s: Summary, info: ReportInfo): string {
  return [
    group('概要', [
      item('取引回数', `${s.trades} 回`),
      item('勝率', pct(s.winRate)),
      item('純損益', yen(s.net), cls(s.net)),
      ...(info.hasBalance ? [item('初期資金からの増減', pct(s.returnPct), cls(s.returnPct))] : []),
      item('プロフィットファクター', num(s.profitFactor, 2), '', '総利益 ÷ 総損失。1 より大きければ利益が出ている'),
      item('期待値（1 回あたり）', yen(s.expectancy), cls(s.expectancy), '純損益 ÷ 取引回数'),
      item('リスクリワード', num(s.payoff, 2), '', '平均利益 ÷ 平均損失'),
    ]),
    group('損益', [
      item('勝ち / 負け / 引き分け', `${s.wins} / ${s.losses} / ${s.even}`),
      item('総利益', yen(s.grossProfit), 'pos'),
      item('総損失', yen(s.grossLoss), 'neg'),
      item('平均利益', yen(s.avgWin), 'pos'),
      item('平均損失', yen(s.avgLoss), 'neg'),
      item('最大利益', yen(s.maxWin), 'pos'),
      item('最大損失', yen(s.maxLoss), 'neg'),
    ]),
    group('pips', [
      item('合計', pips(s.totalPips), cls(s.totalPips)),
      item('平均', pips(s.avgPips), cls(s.avgPips)),
      item('勝ちの平均', pips(s.avgWinPips), 'pos'),
      item('負けの平均', pips(s.avgLossPips), 'neg'),
      item('最大の含み益の平均（MFE）', pips(s.avgMfe), '', '保有中に一番有利だったときの値幅'),
      item('最大の含み損の平均（MAE）', pips(s.avgMae), '', '保有中に一番不利だったときの値幅'),
    ]),
    group('リスク', [
      item('最大ドローダウン', `${yen(s.maxDrawdown)}${info.hasBalance ? `（${pct(s.maxDrawdownPct)}）` : ''}`, 'neg', '残高の一番高い所からの下げ'),
      item('リカバリーファクター', num(s.recoveryFactor, 2), '', '純損益 ÷ 最大ドローダウン'),
      item('最大連勝', `${s.maxConsecWins} 回`),
      item('最大連敗', `${s.maxConsecLosses} 回`),
      item('平均 R', s.rTrades ? `${num(s.avgR, 2)} R（${s.rTrades} 回）` : '—', cls(s.avgR), '決済した時点の S/L までの値幅を 1R とした損益'),
    ]),
    group('保有時間・頻度', [
      item('平均', mins(s.avgHold)),
      item('勝ちの平均', mins(s.avgHoldWin)),
      item('負けの平均', mins(s.avgHoldLoss)),
      item('最長 / 最短', `${mins(s.maxHold)} / ${mins(s.minHold)}`),
      item('期間', `${num(s.days, 1)} 日`),
      item('1 日あたり', `${num(s.tradesPerDay, 1)} 回`),
    ]),
    group('決済の内訳', [item('S/L', `${s.slHits} 回`), item('T/P', `${s.tpHits} 回`), item('手動', `${s.manual} 回`)]),
  ].join('');
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
    ${card('主な数字', `<div class="stat-groups">${summaryGroups(s, info)}</div>`, true)}
    ${card('取引ごとの損益', barChart(a.trades.map((t, i) => ({ label: `${i + 1}`, value: t.profit, note: `#${t.ticket} ${t.side} ${t.pips.toFixed(1)} pips` }))), true)}
    ${card('pips の分布（回数）', barChart(a.pipsHistogram.map((b, i) => ({ label: b.label, value: b.trades, tone: i < 6 ? 'neg' : 'pos' })), { labelEvery: 2, unit: ' 回' }))}
    ${card('買い・売り別', sideTable(a))}
    ${card('曜日別の損益（エントリーした日）', barChart(toBars(a.byWeekday), { labelEvery: 1 }) + bucketTable(a.byWeekday, '曜日'))}
    ${card('時間帯別の損益（エントリーした時刻）', barChart(toBars(a.bySession), { labelEvery: 1 }) + bucketTable(a.bySession, '時間帯'))}
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
.report-table td.num { text-align: right; }
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
