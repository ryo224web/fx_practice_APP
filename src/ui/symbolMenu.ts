// ツールバーの銘柄の選択。ふつうの選ぶ欄（select）の一覧はドラッグできないので、同じ見た目のボタンと一覧を自分で出す。
// 一覧の行をクリックすると選び、ドラッグすると並びを変える（行の上半分に落とすとその上、下半分なら下）。
// 値は今までどおり隠した select に持つ（新しい検証の銘柄の欄もこの並びを写す）。
// 一覧は 2 列。右の列は初めは空で、行をドラッグして左右の列を行き来できる（空の所に落とすとその列の一番下。2026-11-25）。
// 右の列の銘柄は option の data-col="2" で持ち、select の並びはいつも「左の列 → 右の列」にそろえる。

export interface SymbolMenuOptions {
  /** 一覧から選んだ（select の値はもう変えてある） */
  onPick: (symbol: string) => void;
  /** 並びを変えた（新しい並びと、右の列の銘柄） */
  onReorder: (order: string[], right: string[]) => void;
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

  const isRight = (op: HTMLOptionElement) => op.dataset.col === '2';
  const row = (op: HTMLOptionElement) =>
    `<div class="sym-row${op.value === select.value ? ' sym-current' : ''}" data-sym="${op.value}" draggable="true" role="option"><span class="sym-check">${op.value === select.value ? '✓' : ''}</span>${op.text}</div>`;
  const render = () => {
    if (!menu) return;
    const ops = [...select.options];
    menu.innerHTML = [ops.filter((op) => !isRight(op)), ops.filter(isRight)]
      .map((list, i) => `<div class="sym-col" data-col="${i + 1}">${list.map(row).join('')}</div>`)
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
    // 落とす所: 行の上（上半分ならその上・下半分なら下）か、列の空いた所（その列の一番下）
    const dropAt = (e: DragEvent) => {
      const el = e.target as HTMLElement;
      const row = el.closest<HTMLElement>('.sym-row');
      if (row) {
        const r = row.getBoundingClientRect();
        return { row, col: null, after: e.clientY > r.top + r.height / 2 };
      }
      const col = el.closest<HTMLElement>('.sym-col');
      return col ? { row: null, col, after: true } : null;
    };
    const clearDrop = () =>
      menu?.querySelectorAll('.sym-drop-before, .sym-drop-after, .sym-drop-end').forEach((x) => x.classList.remove('sym-drop-before', 'sym-drop-after', 'sym-drop-end'));
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
      if (at.row) at.row.classList.add(at.after ? 'sym-drop-after' : 'sym-drop-before');
      else at.col!.classList.add('sym-drop-end');
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
      const ops = [...select.options];
      const moved = ops.find((op) => op.value === sym)!;
      const value = select.value;
      if (at.row) {
        const to = at.row.dataset.sym!;
        if (to === sym) return;
        const target = ops.find((op) => op.value === to)!;
        moved.dataset.col = isRight(target) ? '2' : '1';
        if (at.after) target.after(moved);
        else target.before(moved);
      } else {
        moved.dataset.col = at.col!.dataset.col!;
      }
      // select の並びを「左の列 → 右の列」にそろえる（列の中の並びはそのまま。列の空いた所に落とした銘柄はその列の一番下）
      const now = [...select.options].filter((op) => op !== moved || at.row);
      const left = now.filter((op) => !isRight(op));
      const right = now.filter(isRight);
      if (!at.row) (isRight(moved) ? right : left).push(moved);
      for (const op of [...left, ...right]) select.add(op);
      select.value = value;
      o.onReorder(
        [...select.options].map((op) => op.value),
        right.map((op) => op.value),
      );
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

/** 右の列に置いた銘柄に印を付ける（select の並びは「左の列 → 右の列」にそろえる） */
export function placeRightColumn(select: HTMLSelectElement, right: string[] | undefined) {
  const set = new Set(right ?? []);
  const ops = [...select.options];
  for (const op of ops) op.dataset.col = set.has(op.value) ? '2' : '1';
  const value = select.value;
  for (const op of [...ops.filter((op) => !set.has(op.value)), ...ops.filter((op) => set.has(op.value))]) select.add(op);
  select.value = value;
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
