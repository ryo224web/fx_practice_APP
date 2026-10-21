// MT4 の「ターミナル」と同じ並びの表。行をダブルクリックすると変更、右クリックでメニュー。

import { formatMoney, formatPrice } from '../core/format';
import type { Account, HistoryRow, PriceFeed } from '../trade/account';
import { computeStats } from '../trade/stats';

export type TerminalTab = 'trade' | 'history' | 'stats';

interface Ctx {
  account: Account;
  feed: PriceFeed;
  index: number;
  digits: number;
  time: (t: number) => string;
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
        <td>${esc(p.comment)}</td></tr>`;
    });
  const level = Number.isFinite(s.level) ? `${s.level.toFixed(2)}%` : '';
  const summary = `<tr class="summary"><td colspan="13">残高: <b>${formatMoney(s.balance)}</b> JPY　有効証拠金: <b>${formatMoney(s.equity)}</b>　証拠金: <b>${formatMoney(s.margin)}</b>　余剰証拠金: <b>${formatMoney(s.free)}</b>　${level ? `証拠金維持率: <b>${level}</b>` : ''}<span class="floating ${s.floating < 0 ? 'neg' : ''}">${formatMoney(s.floating)}</span></td></tr>`;
  const orders = a.orders
    .slice()
    .sort((x, y) => x.ticket - y.ticket)
    .map((o) => {
      const now = o.type.startsWith('buy') ? ask : bid;
      return `<tr data-ticket="${o.ticket}" data-kind="order" class="pending">
        <td>${o.ticket}</td><td>${c.time(o.placedTime)}</td><td>${TYPE_LABEL[o.type]}</td><td class="num">${lots(o.lots)}</td>
        <td>${esc(o.symbol.toLowerCase())}</td><td class="num">${price(o.price, c.digits)}</td>
        <td class="num">${price(o.sl, c.digits)}</td><td class="num">${price(o.tp, c.digits)}</td>
        <td class="num">${price(now, c.digits)}</td><td></td><td></td><td></td><td></td></tr>`;
    });
  return `<table><thead><tr><th>注文番号</th><th>注文時間</th><th>取引種別</th><th>数量</th><th>通貨ペア</th><th>価格</th><th>決済逆指値(S/L)</th><th>決済指値(T/P)</th><th>価格</th><th>手数料</th><th>スワップ</th><th>損益</th><th>コメント</th></tr></thead>
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
      return `<tr data-ticket="${h.ticket}" data-kind="history">
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

export function renderStats(c: Ctx): string {
  const s = computeStats(c.account.history);
  const n = (v: number, d = 0) => (Number.isFinite(v) ? v.toLocaleString('ja-JP', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');
  const item = (k: string, v: string) => `<div class="stat"><span>${k}</span><b>${v}</b></div>`;
  return `<div class="stats">
    ${item('取引回数', n(s.trades))}${item('勝ち', n(s.wins))}${item('負け', n(s.losses))}${item('勝率', `${n(s.winRate, 1)}%`)}
    ${item('純損益', n(s.net))}${item('総利益', n(s.grossProfit))}${item('総損失', n(s.grossLoss))}${item('プロフィットファクター', s.profitFactor === Infinity ? '∞' : n(s.profitFactor, 2))}
    ${item('平均利益', n(s.avgWin))}${item('平均損失', n(s.avgLoss))}${item('期待値（1 回あたり）', n(s.expectancy))}${item('最大ドローダウン', `${n(s.maxDrawdown)}（${n(s.maxDrawdownPct, 2)}%）`)}
    ${item('最大利益', n(s.maxWin))}${item('最大損失', n(s.maxLoss))}${item('最大連勝', n(s.maxConsecWins))}${item('最大連敗', n(s.maxConsecLosses))}
  </div>`;
}

function closeTime(h: HistoryRow): number {
  return h.kind === 'balance' ? h.time : h.closeTime;
}
