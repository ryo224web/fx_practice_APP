// 簡易メモ（ツールバーの「📝 メモ」）。階層つきの箇条書きで、全部のプロジェクトで共通（保存先の settings.json の quickNotes）。
// Enter で次の行、Tab で字下げ、Shift+Tab で戻す、空の行で Backspace を押すと消す、↑↓ で行を移る。
// 下に階層がある行は、左の ▾ でたたむ。欄の外をクリックするか Esc で閉じる。
// プロジェクトごとのメモは、ターミナルの「メモ」タブ（state.note）

export interface NoteItem {
  id: string;
  text: string;
  /** 字下げの段（0 が一番上） */
  level: number;
  /** 下の階層をたたんでいるか */
  collapsed?: boolean;
}

const INDENT = 18;
const newItem = (level = 0, text = ''): NoteItem => ({ id: crypto.randomUUID(), text, level });

/** i 番目の行と、その下の階層（i より深い行が続く所まで）の終わり（含まない） */
function subtreeEnd(items: NoteItem[], i: number): number {
  let j = i + 1;
  while (j < items.length && items[j].level > items[i].level) j++;
  return j;
}

const hasChildren = (items: NoteItem[], i: number) => i + 1 < items.length && items[i + 1].level > items[i].level;

/** たたんだ行の下にあって見えない行 */
function hiddenRows(items: NoteItem[]): Set<number> {
  const hidden = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    if (hidden.has(i) || !items[i].collapsed) continue;
    for (let j = i + 1; j < subtreeEnd(items, i); j++) hidden.add(j);
  }
  return hidden;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function setupQuickNotes(button: HTMLElement, load: () => NoteItem[] | undefined, save: (items: NoteItem[]) => void) {
  const panel = document.createElement('div');
  panel.className = 'quick-notes';
  panel.hidden = true;
  document.body.append(panel);
  let items: NoteItem[] = [];
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const persist = (now = false) => {
    clearTimeout(saveTimer);
    if (now) save(items);
    else saveTimer = setTimeout(() => save(items), 500);
  };

  /** 描き直して、id の行の入力欄に移る（caret: 文字のどこに置くか。-1 は最後） */
  const render = (focusId?: string, caret = -1) => {
    if (!items.length) items = [newItem()];
    const hidden = hiddenRows(items);
    panel.innerHTML =
      // 使い方の説明は、見出しにマウスを乗せたときだけ出す
      '<div class="qn-head" title="Enter 次の行・Tab 字下げ・Shift+Tab 戻す・▾ でたたむ（全プロジェクト共通）"><b>メモ</b></div>' +
      items
        .map((it, i) => {
          if (hidden.has(i)) return '';
          const fold = hasChildren(items, i) ? `<button type="button" class="qn-fold" data-i="${i}" title="${it.collapsed ? '開く' : 'たたむ'}">${it.collapsed ? '▸' : '▾'}</button>` : '<span class="qn-dot">•</span>';
          return `<div class="qn-row" style="padding-left:${it.level * INDENT}px">${fold}<input data-i="${i}" value="${esc(it.text)}" spellcheck="false" /></div>`;
        })
        .join('');
    if (focusId) {
      const i = items.findIndex((x) => x.id === focusId);
      const input = panel.querySelector<HTMLInputElement>(`input[data-i="${i}"]`);
      if (input) {
        input.focus();
        const at = caret < 0 ? input.value.length : caret;
        input.setSelectionRange(at, at);
      }
    }
  };

  const open = () => {
    items = structuredClone(load() ?? []);
    if (!items.length) items = [newItem()];
    const r = button.getBoundingClientRect();
    panel.style.top = `${r.bottom + 4}px`;
    panel.style.left = `${Math.max(8, Math.min(window.innerWidth - 420, r.left))}px`;
    panel.hidden = false;
    button.setAttribute('aria-pressed', 'true');
    render(items.at(-1)?.id);
  };
  const close = () => {
    if (panel.hidden) return;
    persist(true);
    panel.hidden = true;
    button.setAttribute('aria-pressed', 'false');
  };

  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  // 欄の外をクリックしたら閉じる
  document.addEventListener('mousedown', (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node) && !button.contains(e.target as Node)) close();
  });

  panel.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.qn-fold');
    if (!b) return;
    const it = items[Number(b.dataset.i)];
    it.collapsed = !it.collapsed;
    persist();
    render(it.id);
  });

  panel.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    items[Number(input.dataset.i)].text = input.value;
    persist();
  });

  panel.addEventListener('keydown', (e) => {
    const input = e.target as HTMLInputElement;
    if (input.tagName !== 'INPUT') return;
    // ショートカット（Space で再生など）に渡さない
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    const i = Number(input.dataset.i);
    const it = items[i];
    const visible = [...panel.querySelectorAll<HTMLInputElement>('input[data-i]')].map((x) => Number(x.dataset.i));
    const pos = visible.indexOf(i);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // カーソルより後ろの文字は次の行へ。下の階層が開いていれば、その最初の子として入れる
      const rest = input.value.slice(input.selectionStart ?? input.value.length);
      it.text = input.value.slice(0, input.selectionStart ?? input.value.length);
      const child = hasChildren(items, i) && !it.collapsed;
      const at = child ? i + 1 : subtreeEnd(items, i);
      const n = newItem(child ? it.level + 1 : it.level, rest);
      items.splice(at, 0, n);
      persist();
      render(n.id, 0);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // 下の階層ごと字下げする（1 つ上の行より 2 段以上は深くしない）
      const end = subtreeEnd(items, i);
      const prev = i > 0 ? items[i - 1].level : -1;
      const d = e.shiftKey ? (it.level > 0 ? -1 : 0) : it.level <= prev ? 1 : 0;
      if (!d) return;
      for (let j = i; j < end; j++) items[j].level += d;
      persist();
      render(it.id, input.selectionStart ?? -1);
    } else if (e.key === 'Backspace' && input.value === '' && items.length > 1) {
      e.preventDefault();
      // 空の行を消す。下の階層は 1 段上げて残す
      const end = subtreeEnd(items, i);
      for (let j = i + 1; j < end; j++) items[j].level = Math.max(0, items[j].level - 1);
      items.splice(i, 1);
      const back = items[visible[pos - 1] ?? 0] ?? items[0];
      persist();
      render(back.id);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const to = visible[pos + (e.key === 'ArrowUp' ? -1 : 1)];
      if (to === undefined) return;
      e.preventDefault();
      render(items[to].id, input.selectionStart ?? -1);
    }
  });
}
