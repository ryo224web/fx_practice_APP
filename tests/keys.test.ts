import { describe, expect, it } from 'vitest';
import { commandIndex, DEFAULT_KEYMAP, KEY_COMMANDS, keyLabel, keyOf, resolveKeymap } from '../src/ui/keys';

const ev = (code: string, key: string, mods: Partial<Record<'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
  code,
  key,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

describe('キーボードのショートカット', () => {
  it('押したキーを割り当ての文字にする', () => {
    expect(keyOf(ev('KeyC', 'c'))).toBe('KeyC');
    // 日本語入力中でも英字はキーの位置で見る
    expect(keyOf(ev('KeyC', 'Process'))).toBe('KeyC');
    expect(keyOf(ev('KeyC', 'こ'))).toBe('KeyC');
    expect(keyOf(ev('KeyC', 'C', { shiftKey: true }))).toBe('Shift+KeyC');
    expect(keyOf(ev('Digit1', '1'))).toBe('Digit1');
    expect(keyOf(ev('Numpad3', '3'))).toBe('Digit3');
    // "+" は JIS（Shift+;）でも US（Shift+=）でもテンキーでも同じ
    expect(keyOf(ev('Semicolon', '+', { shiftKey: true }))).toBe('+');
    expect(keyOf(ev('Equal', '+', { shiftKey: true }))).toBe('+');
    expect(keyOf(ev('NumpadAdd', '+'))).toBe('+');
    expect(keyOf(ev('Space', ' '))).toBe('Space');
    expect(keyOf(ev('ArrowRight', 'ArrowRight', { shiftKey: true }))).toBe('Shift+ArrowRight');
    expect(keyOf(ev('KeyS', 's', { ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+KeyS');
    // ⌘・決まった働きのキー・修飾キーだけは使わない
    expect(keyOf(ev('KeyC', 'c', { metaKey: true }))).toBe(null);
    expect(keyOf(ev('Escape', 'Escape'))).toBe(null);
    expect(keyOf(ev('Delete', 'Delete'))).toBe(null);
    expect(keyOf(ev('ShiftLeft', 'Shift', { shiftKey: true }))).toBe(null);
  });

  it('画面に出す名前', () => {
    expect(keyLabel('KeyC')).toBe('C');
    expect(keyLabel('Digit1')).toBe('1');
    expect(keyLabel('Shift+ArrowRight')).toBe('Shift+→');
    expect(keyLabel('+')).toBe('+');
    expect(keyLabel('Ctrl++')).toBe('Ctrl++');
    expect(keyLabel('F9')).toBe('F9');
  });

  it('初期の割り当てはキーが重ならず、今までのショートカットと同じ', () => {
    const all = Object.values(DEFAULT_KEYMAP).flat();
    expect(new Set(all).size).toBe(all.length);
    for (const id of Object.keys(DEFAULT_KEYMAP)) expect(KEY_COMMANDS.some((c) => c.id === id)).toBe(true);
    const idx = commandIndex(resolveKeymap(undefined));
    expect(idx.get('Space')).toBe('play');
    expect(idx.get('KeyC')).toBe('fwd');
    expect(idx.get('ArrowLeft')).toBe('back');
    expect(idx.get('Shift+ArrowRight')).toBe('fwdMin');
    expect(idx.get('KeyF')).toBe('tool:fibo');
    expect(idx.get('F9')).toBe('newOrder');
    expect(idx.get('Digit1')).toBe('tf:M1');
    expect(idx.get('Digit9')).toBe('tf:MN');
    // Shift+Z は「標準」。Z だけなら 1 本戻る
    expect(idx.get('Shift+KeyZ')).toBe('zoomReset');
    expect(idx.get('KeyZ')).toBe('back');
    expect(idx.get('KeyO')).toBe('easyOrder');
  });

  it('保存した割り当てが優先され、ほかの働きに移したキーは初期値の側から外れる', () => {
    // 保存に無い働き（後から増えた働きなど）は初期値。ただし KeyC を時間足に移したら、1 本進むからは外れる
    const map = resolveKeymap({ 'tf:H1': ['KeyC'] });
    expect(map['tf:H1']).toEqual(['KeyC']);
    expect(map.fwd).toEqual(['ArrowRight']);
    expect(commandIndex(map).get('KeyC')).toBe('tf:H1');
    // 空にした働きは空のまま
    expect(resolveKeymap({ play: [] }).play).toEqual([]);
  });
});
