// ツールバーの銘柄の選択。ふつうの選ぶ欄（select）の一覧はドラッグできないので、同じ見た目のボタンと一覧を自分で出す。
// 一覧の行をクリックすると選び、ドラッグすると並びを変える（行の上半分に落とすとその上、下半分なら下）。
// 値は今までどおり隠した select に持つ（新しい検証の銘柄の欄もこの並びを写す）。

export interface SymbolMenuOptions {
  /** 一覧から選んだ（select の値はもう変えてある） */
  onPick: (symbol: string) => void;
  /** 並びを変えた（新しい並び） */
  onReorder: (order: string[]) => void;
}

export interface SymbolMenu {
  /** ボタンの表示を select の値と隠すかどうかに合わせる */
  refresh: () => void;
}

export function initSymbolMenu(select: HTMLSelectElement, o: SymbolMenuOptions): SymbolMenu {
  const btn = document.createElement('button');
  btn.id = 'symbol-btn';
  btn.type = 'button';
  btn.title = '銘柄（一覧の行をドラッグすると並びを変えられます）';
  btn.setAttribute('aria-haspopup', 'listbox');
  select.after(btn);
  select.style.display = 'none';

  let menu: HTMLElement | null = null;
  const close = () => {
    menu?.remove();
    menu = null;
    document.removeEventListener('mousedown', onDown, true);
    window.removeEventListener('keydown', onKey, true);
  };
  const onDown = (e: MouseEvent) => {
    if (menu && !menu.contains(e.target as Node) && e.target !== btn) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopImmediatePropagation();
    e.preventDefault();
    close();
  };

  const render = () => {
    if (!menu) return;
    menu.innerHTML = [...select.options]
      .map(
        (op) =>
          `<div class="sym-row${op.value === select.value ? ' sym-current' : ''}" data-sym="${op.value}" draggable="true" role="option"><span class="sym-check">${op.value === select.value ? '✓' : ''}</span>${op.text}</div>`,
      )
      .join('');
  };

  const open = () => {
    menu = document.createElement('div');
    menu.className = 'symbol-menu';
    menu.setAttribute('role', 'listbox');
    render();
    document.body.append(menu);
    const r = btn.getBoundingClientRect();
    const h = menu.getBoundingClientRect().height;
    menu.style.left = `${Math.max(4, Math.min(r.left, innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(r.bottom + 2, innerHeight - h - 4))}px`;

    menu.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.sym-row');
      if (!row) return;
      close();
      if (row.dataset.sym === select.value) return;
      select.value = row.dataset.sym!;
      refresh();
      o.onPick(select.value);
    });

    let dragSym: string | null = null;
    const dropAt = (e: DragEvent) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.sym-row');
      if (!row) return null;
      const r = row.getBoundingClientRect();
      return { row, after: e.clientY > r.top + r.height / 2 };
    };
    const clearDrop = () => menu?.querySelectorAll('.sym-drop-before, .sym-drop-after').forEach((x) => x.classList.remove('sym-drop-before', 'sym-drop-after'));
    menu.addEventListener('dragstart', (e) => {
      dragSym = (e.target as HTMLElement).closest<HTMLElement>('.sym-row')?.dataset.sym ?? null;
      if (dragSym && e.dataTransfer) {
        e.dataTransfer.setData('text/plain', dragSym);
        e.dataTransfer.effectAllowed = 'move';
      }
    });
    menu.addEventListener('dragover', (e) => {
      const at = dragSym ? dropAt(e) : null;
      clearDrop();
      if (!at) return;
      e.preventDefault();
      at.row.classList.add(at.after ? 'sym-drop-after' : 'sym-drop-before');
    });
    menu.addEventListener('dragend', () => {
      dragSym = null;
      clearDrop();
    });
    menu.addEventListener('drop', (e) => {
      const at = dropAt(e);
      const sym = dragSym;
      clearDrop();
      dragSym = null;
      if (!at || !sym) return;
      e.preventDefault();
      const to = at.row.dataset.sym!;
      if (to === sym) return;
      const moved = [...select.options].find((op) => op.value === sym)!;
      const target = [...select.options].find((op) => op.value === to)!;
      const value = select.value;
      if (at.after) target.after(moved);
      else target.before(moved);
      select.value = value;
      o.onReorder([...select.options].map((op) => op.value));
      render();
    });

    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
  };

  btn.addEventListener('click', () => (menu ? close() : open()));

  const refresh = () => {
    btn.hidden = select.hidden;
    btn.textContent = `${select.selectedOptions[0]?.text ?? ''} ▾`;
    render();
  };
  refresh();
  return { refresh };
}

/** 保存した並びに合わせる（並びに無い銘柄は、元の並びのまま後ろに置く） */
export function orderSymbols(symbols: string[], order: string[] | undefined): string[] {
  if (!order?.length) return symbols;
  const rank = new Map(order.map((s, i) => [s, i]));
  return symbols
    .map((s, i) => ({ s, k: rank.get(s) ?? order.length + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.s);
}
