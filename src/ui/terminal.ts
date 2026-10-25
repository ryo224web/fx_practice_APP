// MT4 の「ターミナル」と同じ並びの表。行をダブルクリックすると変更、右クリックでメニュー。

import { formatMoney, formatPrice } from '../core/format';
import type { Account, HistoryRow, PriceFeed } from '../trade/account';

export type TerminalTab = 'trade' | 'history' | 'stats' | 'mt4' | 'memo';

interface Ctx {
  account: Account;
  feed: PriceFeed;
  index: number;
  digits: number;
  time: (t: number) => string;
  /** 決済・削除の ✕ を出さない（MT4 の取引の口座） */
  readOnly?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
/** MT4 と同じく、未設定は 0 と表示する */
const price = (p: number | null | undefined, d: number) => formatPrice(p ?? 0, d);
const money = (v: number) => `<td class="num ${v < 0 ? 'neg' : ''}">${formatMoney(v)}</td>`;
const lots = (n: number) => n.toFixed(2);

const TYPE_LABEL: Record<string, string> = {
  buy: 'buy',
  sell: 'sell',
  buylimit: 'buy limit',
  selllimit: 'sell limit',
  buystop: 'buy stop',
  sellstop: 'sell stop',
};

export function renderTrade(c: Ctx): string {
  const a = c.account;
  const s = a.summary(c.feed, c.index);
  const bid = c.feed.bid[c.index]?.c;
  const ask = c.feed.ask[c.index]?.c;
  const rows = a.positions
    .slice()
    .sort((x, y) => x.ticket - y.ticket)
    .map((p) => {
      const now = p.side === 'buy' ? bid : ask;
      return `<tr data-ticket="${p.ticket}" data-kind="position">
        <td>${p.ticket}</td><td>${c.time(p.openTime)}</td><td class="${p.side}">${p.side}</td><td class="num">${lots(p.lots)}</td>
        <td>${esc(p.symbol.toLowerCase())}</td><td class="num">${price(p.openPrice, c.digits)}</td>
        <td class="num">${price(p.sl, c.digits)}</td><td class="num">${price(p.tp, c.digits)}</td>
        <td class="num">${price(now, c.digits)}</td><td class="num">0</td><td class="num">0</td>${money(a.floatingOf(c.feed, c.index, p))}
        <td>${esc(p.comment)}</td><td class="x">${c.readOnly ? '' : `<button type="button" class="close-x" data-action="close" data-ticket="${p.ticket}" title="決済">✕</button>`}</td></tr>`;
    });
  const level = Number.isFinite(s.level) ? `${s.level.toFixed(2)}%` : '';
  const summary = `<tr class="summary"><td colspan="14">残高: <b>${formatMoney(s.balance)}</b> JPY　有効証拠金: <b>${formatMoney(s.equity)}</b>　証拠金: <b>${formatMoney(s.margin)}</b>　余剰証拠金: <b>${formatMoney(s.free)}</b>　${level ? `証拠金維持率: <b>${level}</b>` : ''}<span class="floating ${s.floating < 0 ? 'neg' : ''}">${formatMoney(s.floating)}</span></td></tr>`;
  const orders = a.orders
    .slice()
    .sort((x, y) => x.ticket - y.ticket)
    .map((o) => {
      const now = o.type.startsWith('buy') ? ask : bid;
      return `<tr data-ticket="${o.ticket}" data-kind="order" class="pending">
        <td>${o.ticket}</td><td>${c.time(o.placedTime)}</td><td>${TYPE_LABEL[o.type]}</td><td class="num">${lots(o.lots)}</td>
        <td>${esc(o.symbol.toLowerCase())}</td><td class="num">${price(o.price, c.digits)}</td>
        <td class="num">${price(o.sl, c.digits)}</td><td class="num">${price(o.tp, c.digits)}</td>
        <td class="num">${price(now, c.digits)}</td><td></td><td></td><td></td><td></td><td class="x"><button type="button" class="close-x" data-action="cancel" data-ticket="${o.ticket}" title="注文を削除">✕</button></td></tr>`;
    });
  return `<table><thead><tr><th>注文番号</th><th>注文時間</th><th>取引種別</th><th>数量</th><th>通貨ペア</th><th>価格</th><th>決済逆指値(S/L)</th><th>決済指値(T/P)</th><th>価格</th><th>手数料</th><th>スワップ</th><th>損益</th><th>コメント</th><th></th></tr></thead>
    <tbody>${rows.join('')}${summary}${orders.join('')}</tbody></table>`;
}

export function renderHistory(c: Ctx): string {
  const rows = c.account.history
    .slice()
    .sort((x, y) => closeTime(x) - closeTime(y))
    .map((h) => {
      if (h.kind === 'balance')
        return `<tr><td>${h.ticket}</td><td>${c.time(h.time)}</td><td>balance</td><td colspan="9">${esc(h.comment)}</td>${money(h.amount)}</tr>`;
      if (h.kind === 'cancelled')
        return `<tr class="pending"><td>${h.ticket}</td><td>${c.time(h.placedTime)}</td><td>${TYPE_LABEL[h.type]}</td><td class="num">${lots(h.lots)}</td><td>${esc(h.symbol.toLowerCase())}</td><td class="num">${price(h.price, c.digits)}</td><td class="num">${price(h.sl, c.digits)}</td><td class="num">${price(h.tp, c.digits)}</td><td>${c.time(h.closeTime)}</td><td>cancelled</td><td></td><td></td><td></td></tr>`;
      const mark = h.reason === 'manual' ? '' : ` [${h.reason}]`;
      return `<tr data-ticket="${h.ticket}" data-close="${h.closeTime}" data-kind="history" title="ダブルクリックで、この取引をチャートに表示">
        <td>${h.ticket}</td><td>${c.time(h.openTime)}</td><td class="${h.side}">${h.side}</td><td class="num">${lots(h.lots)}</td>
        <td>${esc(h.symbol.toLowerCase())}</td><td class="num">${price(h.openPrice, c.digits)}</td>
        <td class="num">${price(h.sl, c.digits)}</td><td class="num">${price(h.tp, c.digits)}</td>
        <td>${c.time(h.closeTime)}</td><td class="num">${price(h.closePrice, c.digits)}${mark}</td><td class="num">0</td><td class="num">0</td>${money(h.profit)}</tr>`;
    });
  const pl = c.account.history.reduce((s, h) => s + (h.kind === 'trade' ? h.profit : 0), 0);
  const dep = c.account.history.reduce((s, h) => s + (h.kind === 'balance' ? h.amount : 0), 0);
  const summary = `<tr class="summary"><td colspan="13">損益: <b class="${pl < 0 ? 'neg' : ''}">${formatMoney(pl)}</b>　入金: <b>${formatMoney(dep)}</b>　出金: <b>0</b>　残高: <b>${formatMoney(c.account.balance)}</b> JPY</td></tr>`;
  return `<table><thead><tr><th>注文番号</th><th>注文時間</th><th>取引種別</th><th>数量</th><th>通貨ペア</th><th>価格</th><th>決済逆指値(S/L)</th><th>決済指値(T/P)</th><th>決済時間</th><th>価格</th><th>手数料</th><th>スワップ</th><th>損益</th></tr></thead>
    <tbody>${rows.join('')}${summary}</tbody></table>`;
}

function closeTime(h: HistoryRow): number {
  return h.kind === 'balance' ? h.time : h.closeTime;
}

/** 読み込んだ MT4 の取引 1 件と、今の時刻での状態 */
export interface Mt4Row {
  ticket: number;
  side: 'buy' | 'sell';
  lots: number;
  openUtc: number;
  openPrice: number;
  sl: number | null;
  tp: number | null;
  closeUtc: number | null;
  closePrice: number | null;
  swap: number;
  commission: number;
  profit: number;
  status: 'wait' | 'open' | 'closed';
  /** 今の価格での含み損益（保有中のときだけ。円換算できなければ NaN） */
  floating: number | null;
  /** 記録の価格がその時刻の足に収まるか（null はデータ無し） */
  matchOpen: boolean | null;
  matchClose: boolean | null;
}

export interface Mt4Info {
  fileName: string;
  offsetHours: number;
  matched: number;
  checked: number;
  /** この銘柄の取引で判定できたか（できなければ、ほかの銘柄の値か 0 を使っている） */
  detected: boolean;
  /** この銘柄以外の取引の件数（表示しない） */
  others: number;
  /** MT4 の EA が書き出す履歴を自動で読み込んでいるか。updated はそのファイルの更新時刻（ミリ秒。まだなら 0） */
  auto: boolean;
  updated: number;
  /** 使う月（"2026-10"。空なら全部）と、履歴に含まれる月 */
  month: string;
  months: string[];
}

const STATUS_LABEL = { wait: '未エントリー', open: '保有中', closed: '決済済み' };

/**
 * @param oldestFirst 古い取引を上にする（初期は新しい取引が上。「注文番号」の見出しをクリックで切り替える）
 */
export function renderMt4(rows: Mt4Row[], info: Mt4Info | null, digits: number, time: (t: number) => string, oldestFirst = false): string {
  const auto = `<button type="button" data-action="mt4-auto" aria-pressed="${!!info?.auto}" title="T580 の MT4 の R_ExportBarsHistory（EA）が、取引を建てた・決済したときに書き出す履歴を、自動で読み込み続けます（届くたびに丸ごと差し替えるので、重なりません）">MT4 から自動で読み込む</button>`;
  const month = info
    ? `<select data-action="mt4-month" title="この月（サーバー時刻）に決済した取引だけを、口座・成績・チャートに使います">
        <option value="">すべての月</option>${info.months.map((m) => `<option value="${m}" ${m === info.month ? 'selected' : ''}>${m.replace('-', ' 年 ')} 月</option>`).join('')}
      </select>`
    : '';
  const bar = `<div class="mt4-bar">${auto}<button type="button" data-action="mt4-load">ファイルから読み込む…</button>${month}${info ? '<button type="button" data-action="mt4-clear">消す</button>' : ''}`;
  if (!info) {
    return `${bar}<span class="hint">「MT4 から自動で読み込む」にすると、MT4 の取引が自動で届きます。手で読み込むときは、MT4 の「口座履歴」の詳細レポート（.htm）か、R_ExportHistory.mq4 で書き出した .csv を選びます。読み込んだら、ローソク足を進めると記録どおりにエントリー・決済が表示されます。</span></div>`;
  }
  const mark = (v: boolean | null) => (v === null ? '' : v ? '✓' : '<b class="neg" title="記録の価格が、その時刻の足の値幅に入っていません">✗</b>');
  const off = `${info.offsetHours >= 0 ? '+' : ''}${info.offsetHours}`;
  const judged = info.detected
    ? `時刻のずれ（自動判定）: <b>${off} 時間</b>　価格が足に収まった: <b>${info.matched}/${info.checked}</b>`
    : `時刻のずれ: <b>${off} 時間</b>（この銘柄では判定できていません。価格データが無いか、取引がありません）`;
  const updated = info.auto && info.updated ? `（最後に MT4 が書き出したのは ${time(info.updated)}）` : '';
  const head = `${bar}<span class="hint">${esc(info.fileName)}${updated}　${judged}${info.others ? `　（他の銘柄 ${info.others} 件は表示していません）` : ''}　行をダブルクリック: 済んだ取引はチャートでその場所を表示（時刻はそのまま）、まだの取引はエントリーの直前まで進む</span></div>`;
  // 並べ方: 注文時間（同じなら注文番号）の順。初期は新しい取引が上
  const sorted = rows.slice().sort((a, b) => (a.openUtc - b.openUtc || a.ticket - b.ticket) * (oldestFirst ? 1 : -1));
  const body = sorted.map((r) => {
    const cls = r.status === 'wait' ? 'pending' : '';
    const pl = r.status === 'closed' ? money(r.profit + r.swap + r.commission) : r.status === 'open' && r.floating !== null ? money(r.floating) : '<td></td>';
    return `<tr data-ticket="${r.ticket}" data-kind="mt4" class="${cls}">
      <td>${r.ticket}</td><td>${STATUS_LABEL[r.status]}</td><td>${time(r.openUtc)}</td><td class="${r.side}">${r.side}</td><td class="num">${lots(r.lots)}</td>
      <td class="num">${price(r.openPrice, digits)} ${mark(r.matchOpen)}</td><td class="num">${price(r.sl, digits)}</td><td class="num">${price(r.tp, digits)}</td>
      <td>${r.closeUtc === null ? '' : time(r.closeUtc)}</td><td class="num">${r.closePrice === null ? '' : `${price(r.closePrice, digits)} ${mark(r.matchClose)}`}</td>
      <td class="num">${formatMoney(r.swap)}</td>${pl}</tr>`;
  });
  const closed = rows.filter((r) => r.status === 'closed');
  const total = closed.reduce((s, r) => s + r.profit + r.swap + r.commission, 0);
  const floating = rows.reduce((s, r) => s + (r.status === 'open' && r.floating !== null && Number.isFinite(r.floating) ? r.floating : 0), 0);
  const summary = `<tr class="summary"><td colspan="12">決済済み ${closed.length} 件の損益（記録の値）: <b class="${total < 0 ? 'neg' : ''}">${formatMoney(total)}</b>　保有中 ${rows.filter((r) => r.status === 'open').length} 件の含み損益: <b class="${floating < 0 ? 'neg' : ''}">${formatMoney(floating)}</b>　未エントリー ${rows.filter((r) => r.status === 'wait').length} 件</td></tr>`;
  return `${head}<table><thead><tr><th class="sortable" data-action="mt4-sort" title="クリックで並べ方を切り替える（新しい順・古い順）">注文番号 ${oldestFirst ? '▲' : '▼'}</th><th>状態</th><th>注文時間</th><th>取引種別</th><th>数量</th><th>価格</th><th>決済逆指値(S/L)</th><th>決済指値(T/P)</th><th>決済時間</th><th>価格</th><th>スワップ</th><th>損益</th></tr></thead>
    <tbody>${summary}${body.join('')}</tbody></table>`;
}
