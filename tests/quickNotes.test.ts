import { describe, expect, it } from 'vitest';
import { listNumbers, parseMarker, type NoteItem } from '../src/ui/quickNotes';

describe('簡易メモの Markdown', () => {
  it('行の頭の印で種類が決まる', () => {
    expect(parseMarker('## 見出し')).toEqual({ kind: 'h2', rest: '見出し' });
    expect(parseMarker('### ')).toEqual({ kind: 'h3', rest: '' });
    expect(parseMarker('# 大')).toEqual({ kind: 'h1', rest: '大' });
    expect(parseMarker('- 箇条')).toEqual({ kind: 'bullet', rest: '箇条' });
    expect(parseMarker('* 箇条')).toEqual({ kind: 'bullet', rest: '箇条' });
    expect(parseMarker('12. 番号')).toEqual({ kind: 'num', rest: '番号' });
    // 印のあとに空白が無ければそのまま（「1.5R」「#112」「-20」など）
    expect(parseMarker('1.5R')).toBeNull();
    expect(parseMarker('#112')).toBeNull();
    expect(parseMarker('-20〜+20')).toBeNull();
    expect(parseMarker('#### 4 つ')).toBeNull();
  });

  it('番号は同じ段で続く番号の行を 1 から数え、別の種類の行で数え直す', () => {
    const it = (kind: NoteItem['kind'], level = 0): NoteItem => ({ id: '', text: '', level, kind });
    const items = [it('num'), it('num'), it('num', 1), it('num', 1), it('num'), it('text'), it('num'), it('bullet', 1), it('num')];
    expect(listNumbers(items)).toEqual([1, 2, 1, 2, 3, 0, 1, 0, 2]);
  });
});
