import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AlertBook, passedRange } from '../server/priceAlerts';

const bar = (t: number, h: number, l: number) => ({ t, h, l });

describe('passedRange', () => {
  it('前の価格と今の価格の間', () => {
    expect(passedRange({ bid: 100, bar: null }, { bid: 101, bar: null })).toEqual({ lo: 100, hi: 101 });
    expect(passedRange(null, { bid: 101, bar: null })).toBeNull();
    expect(passedRange({ bid: 100, bar: null }, { bid: 100, bar: null })).toBeNull();
  });
  it('同じ 1 分足で高値が伸びた分も入れる（間のひげ）', () => {
    expect(passedRange({ bid: 100, bar: bar(0, 100.5, 99) }, { bid: 100.2, bar: bar(0, 101, 99) })).toEqual({ lo: 100, hi: 101 });
    // 伸びていない前の高値は入れない
    expect(passedRange({ bid: 100, bar: bar(0, 103, 99) }, { bid: 100.2, bar: bar(0, 103, 99) })).toEqual({ lo: 100, hi: 100.2 });
  });
  it('新しい 1 分足ならその足の高値・安値', () => {
    expect(passedRange({ bid: 100, bar: bar(0, 100, 100) }, { bid: 100.1, bar: bar(60_000, 100.4, 99.8) })).toEqual({ lo: 99.8, hi: 100.4 });
  });
});

describe('AlertBook', () => {
  it('届いた銘柄のアラートだけ鳴らして外し、ファイルに残す', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'fxp-alerts-'));
    const file = path.join(dir, 'alerts.json');
    const notes: string[] = [];
    const book = new AlertBook(file, (t) => notes.push(t));
    const events: string[] = [];
    book.subs.add((e) => events.push(e.type));
    await book.replace('usdjpy', [
      { id: 'a', sym: 'usdjpy', p: 150.5, t: 0 },
      { id: 'b', sym: 'usdjpy', p: 152, t: 0 },
    ]);
    await book.replace('xauusd', [{ id: 'c', sym: 'xauusd', p: 2000, t: 0 }]);
    await book.check('usdjpy', { bid: 150.2, bar: null }, 3);
    await book.check('usdjpy', { bid: 150.6, bar: null }, 3);
    expect(notes).toEqual(['USDJPY 150.500']);
    expect((await book.list()).map((a) => a.id).sort()).toEqual(['b', 'c']);
    expect(events).toContain('fired');
    expect(JSON.parse(readFileSync(file, 'utf8')).alerts.map((a: { id: string }) => a.id).sort()).toEqual(['b', 'c']);
    // 古い画面が鳴ったアラートを送り直しても、生き返らせない
    await book.replace('usdjpy', [
      { id: 'a', sym: 'usdjpy', p: 150.5, t: 0 },
      { id: 'b', sym: 'usdjpy', p: 152, t: 0 },
    ]);
    expect((await book.list()).map((a) => a.id).sort()).toEqual(['b', 'c']);
  });
});
