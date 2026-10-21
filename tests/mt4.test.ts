import { describe, expect, it } from 'vitest';
import type { Bar } from '../src/core/candles';
import { detectOffsetHours, parseHistoryCsv, parseStatementHtml, type PriceLookup } from '../src/mt4/history';

// MT4 の詳細レポートの形（一部）
const HTML = `
<table>
<tr align=center><td colspan=13><b>Closed Transactions:</b></td></tr>
<tr align=center bgcolor="#C0C0C0"><td>Ticket</td><td nowrap>Open Time</td><td>Type</td><td>Size</td><td>Item</td><td>Price</td><td>S / L</td><td>T / P</td><td nowrap>Close Time</td><td>Price</td><td>Commission</td><td>Taxes</td><td>Swap</td><td>Profit</td></tr>
<tr bgcolor="#FFFFFF" align=right><td title="#1234">12345678</td><td class=msdate nowrap>2026.10.20 15:30:12</td><td>buy</td><td class=mspt>0.50</td><td>usdjpy.a</td><td style="mso-number-format:0\\.000;">158.224</td><td style="mso-number-format:0\\.000;">157.982</td><td style="mso-number-format:0\\.000;">158.476</td><td class=msdate nowrap>2026.10.20 18:00:05</td><td style="mso-number-format:0\\.000;">158.476</td><td class=mspt>0</td><td class=mspt>0</td><td class=mspt>-120</td><td class=mspt>12 600</td></tr>
<tr bgcolor="#E0E0E0" align=right><td>12345679</td><td class=msdate nowrap>2026.10.20 19:00:00</td><td>balance</td><td colspan=10 align=left>Deposit</td><td class=mspt>100 000.00</td></tr>
<tr bgcolor="#FFFFFF" align=right><td>12345680</td><td class=msdate nowrap>2026.10.20 20:00:00</td><td>sell limit</td><td class=mspt>0.10</td><td>usdjpy</td><td>158.800</td><td>0.000</td><td>0.000</td><td class=msdate nowrap>2026.10.21 01:00:00</td><td>158.500</td><td colspan=4>cancelled</td></tr>
<tr align=center><td colspan=13><b>Open Trades:</b></td></tr>
<tr bgcolor="#FFFFFF" align=right><td>12345690</td><td class=msdate nowrap>2026.10.21 09:00:00</td><td>sell</td><td class=mspt>0.20</td><td>usdjpy</td><td>158.300</td><td>158.500</td><td>0.000</td><td>&nbsp;</td><td>158.250</td><td class=mspt>0</td><td class=mspt>0</td><td class=mspt>0</td><td class=mspt>1 000</td></tr>
</table>`;

describe('MT4 の取引履歴', () => {
  it('詳細レポート（.htm）から決済済み・保有中の取引を読む（入金と取消は除く）', () => {
    const t = parseStatementHtml(HTML);
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({
      ticket: 12345678,
      side: 'buy',
      lots: 0.5,
      symbol: 'USDJPY',
      openServer: Date.UTC(2026, 9, 20, 15, 30, 12),
      openPrice: 158.224,
      sl: 157.982,
      tp: 158.476,
      closePrice: 158.476,
      swap: -120,
      profit: 12600,
    });
    expect(t[1]).toMatchObject({ ticket: 12345690, side: 'sell', closeServer: null, closePrice: null, tp: null });
  });

  it('ExportHistory.mq4 の CSV を読む', () => {
    const csv = [
      'ticket,open_time,type,lots,symbol,open_price,sl,tp,close_time,close_price,commission,swap,profit,comment',
      '1,2026.10.20 15:30:12,buy,0.50,USDJPY,158.224,157.982,158.476,2026.10.20 18:00:05,158.476,0,-120,12600,test',
      '2,2026.10.21 09:00:00,sell,0.20,USDJPY,158.300,158.500,0,,,0,0,1000,',
    ].join('\n');
    const t = parseHistoryCsv(csv);
    expect(t).toHaveLength(2);
    expect(t[0].comment).toBe('test');
    expect(t[1].closeServer).toBeNull();
  });

  it('記録の価格が足に収まるように、時刻のずれを見つける', () => {
    // 本当は UTC = サーバー時刻 - 3 時間 なのに、変換を間違えて -1 時間にしている場合 → ずれは -2 時間
    const bars = new Map<number, { bid: Bar; ask: Bar }>();
    const add = (utc: number, lo: number, hi: number) => {
      const bid = { t: utc, o: lo, h: hi, l: lo, c: hi };
      bars.set(utc, { bid, ask: { ...bid, o: lo + 0.004, h: hi + 0.004, l: lo + 0.004, c: hi + 0.004 } });
    };
    // 1 時間ごとに価格帯が違う足を置く
    for (let h = 0; h < 24; h++) add(Date.UTC(2026, 9, 20, h, 0), 150 + h, 150 + h + 0.5);
    const lookup: PriceLookup = { bar: (utc) => bars.get(Math.floor(utc / 3_600_000) * 3_600_000) ?? null };
    const trades = parseHistoryCsv(
      'h\n1,2026.10.20 15:00:00,sell,0.1,USDJPY,162.2,0,0,2026.10.20 18:10:00,165.3,0,0,0,\n',
    );
    const wrongToUtc = (s: number) => s - 1 * 3_600_000;
    expect(detectOffsetHours(trades, wrongToUtc, lookup, 0.01)).toMatchObject({ hours: -2, matched: 2 });
  });
});

describe('銘柄名の読み替え', () => {
  it('接尾辞を取り除き、GOLD などは通貨ペアの名前にする', async () => {
    const { normalizeSymbol } = await import('../src/mt4/history');
    expect(normalizeSymbol('usdjpy.a')).toBe('USDJPY');
    expect(normalizeSymbol('EURUSDmicro')).toBe('EURUSD');
    expect(normalizeSymbol('GOLD')).toBe('XAUUSD');
    expect(normalizeSymbol('GOLD.a')).toBe('XAUUSD');
    expect(normalizeSymbol('XAUUSD')).toBe('XAUUSD');
  });
});

describe('詳細レポートの税金', () => {
  it('税金（Taxes）は手数料に含める', () => {
    const row = `<tr><td>1</td><td>2026.10.20 15:30:12</td><td>buy</td><td>0.10</td><td>usdjpy</td><td>158.000</td><td>0.000</td><td>0.000</td><td>2026.10.20 16:00:00</td><td>158.100</td><td>-50</td><td>-20</td><td>0</td><td>1 000</td></tr>`;
    const [t] = parseStatementHtml(`<table>${row}</table>`);
    expect(t.commission).toBe(-70);
    expect(t.profit).toBe(1000);
  });
});
