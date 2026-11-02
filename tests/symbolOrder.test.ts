import { describe, expect, it } from 'vitest';
import { orderSymbols } from '../src/ui/symbolMenu';

describe('orderSymbols', () => {
  it('follows the saved order and keeps unknown symbols at the end in their original order', () => {
    expect(orderSymbols(['usdjpy', 'eurusd', 'xauusd', 'jp225'], ['xauusd', 'gone', 'usdjpy'])).toEqual(['xauusd', 'usdjpy', 'eurusd', 'jp225']);
    expect(orderSymbols(['a', 'b'], undefined)).toEqual(['a', 'b']);
  });
});
