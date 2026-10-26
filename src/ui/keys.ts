// キーボードのショートカット（「ショートカット」の画面で好きなキーに変えられる）。
// キーは文字で持つ: 英字・数字はキーの位置（KeyC・Digit1。日本語入力中でも効くように）、
// 記号は出てくる文字（"+" など。JIS と US の配列で同じ記号が使えるように。Shift は見ない）、
// それ以外はキーの名前（ArrowRight・F9・Space）。前に Ctrl+・Alt+・Shift+ が付く。
// ⌘ の付いたキー（⌘C など）と Esc・Enter・Delete・Backspace は割り当てない（決まった働きがあるため）。

import { TIMEFRAMES, type Timeframe } from '../core/candles';

export interface KeyCommand {
  id: string;
  label: string;
  group: string;
}

const TFS = Object.keys(TIMEFRAMES) as Timeframe[];

export const KEY_COMMANDS: KeyCommand[] = [
  { id: 'play', label: '再生・一時停止', group: 'リプレイ' },
  { id: 'fwd', label: '1 本進む', group: 'リプレイ' },
  { id: 'back', label: '1 本戻る', group: 'リプレイ' },
  { id: 'fwdMin', label: '1 分進む', group: 'リプレイ' },
  { id: 'backMin', label: '1 分戻る', group: 'リプレイ' },
  ...TFS.map((tf) => ({ id: `tf:${tf}`, label: tf, group: '時間足' })),
  { id: 'tfUp', label: '1 つ長い時間足', group: '時間足' },
  { id: 'tfDown', label: '1 つ短い時間足', group: '時間足' },
  { id: 'zoomIn', label: '拡大', group: 'チャート' },
  { id: 'zoomOut', label: '縮小', group: 'チャート' },
  { id: 'zoomReset', label: '標準（拡大縮小を戻す）', group: 'チャート' },
  { id: 'toNow', label: '最新の足へ移動', group: 'チャート' },
  { id: 'crosshair', label: '十字線を出す・消す', group: 'チャート' },
  { id: 'tool:hline', label: '水平線', group: '描画' },
  { id: 'tool:vline', label: '垂直線', group: '描画' },
  { id: 'tool:trend', label: 'トレンドライン', group: '描画' },
  { id: 'tool:poly', label: 'ポリライン', group: '描画' },
  { id: 'tool:channel', label: 'チャネル', group: '描画' },
  { id: 'tool:rect', label: '長方形', group: '描画' },
  { id: 'tool:fibo', label: 'フィボナッチ', group: '描画' },
  { id: 'tool:fiboexp', label: 'フィボナッチ・エクスパンション', group: '描画' },
  { id: 'magnet', label: 'マグネットを入れる・切る', group: '描画' },
  { id: 'newOrder', label: '新規注文', group: '注文' },
  { id: 'easyOrder', label: 'EasyOrder を開く・閉じる', group: '注文' },
];

/** 初期の割り当て（1 つの働きに 2 つまで） */
export const DEFAULT_KEYMAP: Record<string, string[]> = {
  play: ['Space'],
  fwd: ['KeyC', 'ArrowRight'],
  back: ['KeyZ', 'ArrowLeft'],
  fwdMin: ['Shift+ArrowRight'],
  backMin: ['Shift+ArrowLeft'],
  ...Object.fromEntries(TFS.map((tf, i) => [`tf:${tf}`, [`Digit${i + 1}`]])),
  zoomIn: ['+'],
  zoomOut: ['-'],
  zoomReset: ['Shift+KeyZ'],
  toNow: ['End'],
  'tool:hline': ['KeyH'],
  'tool:trend': ['KeyT'],
  'tool:poly': ['KeyW'],
  'tool:fibo': ['KeyF'],
  'tool:fiboexp': ['KeyE'],
  magnet: ['KeyM'],
  newOrder: ['F9'],
  easyOrder: ['KeyO'],
};

/** 割り当てられないキー（決まった働きがある） */
const RESERVED = new Set(['Escape', 'Enter', 'Delete', 'Backspace', 'Tab']);
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Process', 'Dead', 'Unidentified']);

/** 押したキーを、割り当てに使う文字にする。割り当てられないキーは null */
export function keyOf(e: Pick<KeyboardEvent, 'code' | 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): string | null {
  if (e.metaKey || RESERVED.has(e.key)) return null;
  let base: string;
  let shift = e.shiftKey;
  // 英字・数字は日本語入力中（key が "Process" になる）でもキーの位置で見る
  if (/^(Key[A-Z]|Digit\d)$/.test(e.code)) base = e.code;
  else if (MODIFIERS.has(e.key)) return null;
  else if (/^Numpad\d$/.test(e.code)) base = `Digit${e.code.slice(6)}`;
  else if (e.key === ' ') base = 'Space';
  else if (e.key.length === 1) {
    // 記号は出てくる文字で見る（"+" は JIS では Shift+;、US では Shift+=。どちらでも "+"）
    base = e.key;
    shift = false;
  } else base = e.key;
  return `${e.ctrlKey ? 'Ctrl+' : ''}${e.altKey ? 'Alt+' : ''}${shift ? 'Shift+' : ''}${base}`;
}

const NAMES: Record<string, string> = {
  ArrowRight: '→',
  ArrowLeft: '←',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Space: 'Space',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/** 画面に出す名前（KeyC → C、Digit1 → 1、Shift+ArrowRight → Shift+→） */
export function keyLabel(k: string): string {
  const parts = k.split('+');
  // "+" そのものと "Shift++" のような記号の + を壊さない
  const base = k.endsWith('+') ? '+' : parts[parts.length - 1];
  const mods = k.endsWith('+') ? parts.slice(0, -2) : parts.slice(0, -1);
  const name = /^Key[A-Z]$/.test(base) ? base.slice(3) : /^Digit\d$/.test(base) ? base.slice(5) : (NAMES[base] ?? base);
  return [...mods, name].join('+');
}

/** 保存した割り当て（無い働きは初期値）。ほかの働きに移したキーは初期値の側から外す */
export function resolveKeymap(saved: Record<string, string[]> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const c of KEY_COMMANDS) out[c.id] = [...(saved?.[c.id] ?? DEFAULT_KEYMAP[c.id] ?? [])];
  if (!saved) return out;
  const owner = new Map<string, string>();
  for (const c of KEY_COMMANDS) if (saved[c.id]) for (const k of saved[c.id]) owner.set(k, c.id);
  for (const c of KEY_COMMANDS) if (!saved[c.id]) out[c.id] = out[c.id].filter((k) => !owner.has(k));
  return out;
}

/** キー → 働き の表 */
export function commandIndex(map: Record<string, string[]>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const c of KEY_COMMANDS) for (const k of map[c.id] ?? []) if (!idx.has(k)) idx.set(k, c.id);
  return idx;
}
