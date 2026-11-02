// 取引に敗因・勝因の札を付ける小さな欄（履歴の行・チャートの矢印の右クリック）。
// チェックで付け外しし、続けて何個でも選べる。1〜9 のキーで上から n 番目を付け外し、下の欄に打って Enter で新しい札を足す。
// 行にマウスを乗せると出る ✎ で名前を変え、🗑 で一覧から消す（付けてある札も数えなくなる）。行をドラッグすると並びを変える。
// もう一方の一覧（勝因なら敗因）にあるフィボの数値の札で、この一覧に無いものはボタン 1 つで写せる。

import type { LossReason } from '../trade/lossReasons';

export interface TagPickerOptions {
  title: string;
  /** 一覧の呼び名（「敗因」「勝因」） */
  label: string;
  reasons: () => LossReason[];
  selected: () => Set<string>;
  onToggle: (id: string, on: boolean) => void;
  /** 新しい札を足して、その ID を返す（足したものは付けた状態にする） */
  onAdd: (name: string) => string;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  /** 並びを変えた（新しい並びの ID） */
  onReorder: (ids: string[]) => void;
  /** もう一方の一覧から写せるフィボの数値の札（無ければボタンを出さない） */
  copyable?: () => string[];
  /** copyable の札を一覧の最後に足す */
  onCopy?: () => void;
  /** 写す元の一覧の呼び名 */
  copyLabel?: string;
}

let current: { el: HTMLElement; close: () => void } | null = null;

export function closeTagPicker() {
  current?.close();
}

export function openTagPicker(x: number, y: number, o: TagPickerOptions) {
  closeTagPicker();
  const el = document.createElement('div');
  el.className = 'tag-picker';
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const render = () => {
    const sel = o.selected();
    const list = o.reasons();
    const copy = o.copyable?.() ?? [];
    el.innerHTML = `<div class="tp-head">${esc(o.title)}</div>
      <div class="tp-list">${
        list.length
          ? list
              .map(
                (r, i) => `<label class="tp-row" data-id="${r.id}" draggable="true" title="ドラッグで並びを変える"><span class="tp-key">${i < 9 ? i + 1 : ''}</span><input type="checkbox" ${sel.has(r.id) ? 'checked' : ''}><span class="tp-name" title="${esc(r.name)}">${esc(r.name)}</span>
                <button type="button" data-tp="rename" title="名前を変える">✎</button><button type="button" data-tp="delete" title="一覧から消す">🗑</button></label>`,
              )
              .join('')
          : `<div class="hint tp-empty">まだ${esc(o.label)}がありません。下に打って Enter で足します</div>`
      }</div>
      <input class="tp-new" type="text" placeholder="新しい${esc(o.label)}を打って Enter" spellcheck="false">
      ${copy.length ? `<button type="button" class="tp-copy" data-tp="copy" title="${esc(copy.join('・'))}">${esc(o.copyLabel ?? '')}のフィボの数値を写す（${copy.length} 個）</button>` : ''}
      <div class="hint tp-hint">1〜9 のキーでも付け外し・ドラッグで並べ替え・Esc で閉じる</div>`;
  };
  render();
  // 行をドラッグして並べ替える（行の上半分に落とすとその上、下半分なら下）
  let dragId: string | null = null;
  const dropAt = (e: DragEvent) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('.tp-row');
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { row, after: e.clientY > r.top + r.height / 2 };
  };
  const clearDrop = () => el.querySelectorAll('.tp-drop-before, .tp-drop-after').forEach((x) => x.classList.remove('tp-drop-before', 'tp-drop-after'));
  el.addEventListener('dragstart', (e) => {
    dragId = (e.target as HTMLElement).closest<HTMLElement>('.tp-row')?.dataset.id ?? null;
    if (dragId && e.dataTransfer) {
      e.dataTransfer.setData('text/plain', dragId);
      e.dataTransfer.effectAllowed = 'move';
    }
  });
  el.addEventListener('dragover', (e) => {
    const at = dragId ? dropAt(e) : null;
    clearDrop();
    if (!at) return;
    e.preventDefault();
    at.row.classList.add(at.after ? 'tp-drop-after' : 'tp-drop-before');
  });
  el.addEventListener('dragend', () => {
    dragId = null;
    clearDrop();
  });
  el.addEventListener('drop', (e) => {
    const at = dropAt(e);
    const id = dragId;
    clearDrop();
    dragId = null;
    if (!at || !id) return;
    e.preventDefault();
    const to = at.row.dataset.id!;
    if (to === id) return;
    const ids = o.reasons().map((r) => r.id).filter((x) => x !== id);
    ids.splice(ids.indexOf(to) + (at.after ? 1 : 0), 0, id);
    o.onReorder(ids);
    render();
  });
  el.addEventListener('change', (e) => {
    const box = e.target as HTMLInputElement;
    const id = box.closest<HTMLElement>('.tp-row')?.dataset.id;
    if (id) o.onToggle(id, box.checked);
  });
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-tp]');
    if (!b) return;
    e.preventDefault();
    if (b.dataset.tp === 'copy') {
      o.onCopy?.();
      render();
      return;
    }
    const id = b.closest<HTMLElement>('.tp-row')!.dataset.id!;
    const r = o.reasons().find((x) => x.id === id);
    if (!r) return;
    if (b.dataset.tp === 'rename') {
      const name = prompt(`${o.label}の名前`, r.name)?.trim();
      if (name) o.onRename(id, name);
    } else if (confirm(`「${r.name}」を一覧から消しますか？（付けた取引からも外れます）`)) o.onDelete(id);
    render();
  });
  el.addEventListener('keydown', (e) => {
    const input = e.target as HTMLInputElement;
    if (!input.classList.contains('tp-new') || e.key !== 'Enter' || e.isComposing) return;
    const name = input.value.trim();
    if (!name) return;
    const id = o.onAdd(name);
    o.onToggle(id, true);
    render();
    el.querySelector<HTMLInputElement>('.tp-new')!.focus();
  });
  // 1〜9 で付け外し、Esc で閉じる（チャートのキー（時間足の切り替えなど）には渡さない）
  const onKey = (e: KeyboardEvent) => {
    const typing = (e.target as HTMLElement | null)?.classList?.contains('tp-new');
    if (e.key === 'Escape') {
      e.stopImmediatePropagation();
      e.preventDefault();
      close();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    const n = /^Digit([1-9])$/.exec(e.code)?.[1];
    if (!n) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const r = o.reasons()[Number(n) - 1];
    if (!r) return;
    o.onToggle(r.id, !o.selected().has(r.id));
    render();
  };
  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) close();
  };
  const close = () => {
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onDown, true);
    el.remove();
    if (current?.el === el) current = null;
  };
  window.addEventListener('keydown', onKey, true);
  // 開いた右クリックの mousedown で閉じないよう、次の操作から見る
  setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
  document.body.append(el);
  // 画面からはみ出さないように置く
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  el.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  current = { el, close };
}
