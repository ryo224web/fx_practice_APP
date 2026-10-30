// 簡易メモ（ツールバーの「📝 メモ」）。Apple のメモと同じく「フォルダ → メモの一覧 → 本文」の 3 列で、全部のプロジェクトで共通
// （保存先の settings.json の notebook。2026-10-30 に 1 枚だけの quickNotes から変えた。以前のメモは「メモ」として 1 枚目に入る）。
// - フォルダ: 左の列。「すべて」と、フォルダの木（中にフォルダを作れる。▾ でたたむ）。右クリックで名前を変える・中にフォルダ・削除
//   （削除しても中のメモとフォルダは 1 つ上へ移す。消えない）。メモやフォルダをドラッグしてフォルダに落とすと移る（「すべて」に落とすとフォルダの外）
// - メモの一覧: 真ん中の列。新しく書き換えた順。1 行目が題名。＋ で今のフォルダに新しいメモ。右クリックで削除。空のまま離れたメモは消す
// - 本文: 右の列。階層つきの箇条書き。Enter で次の行、Tab で字下げ、Shift+Tab で戻す、空の行で Backspace を押すと消す、↑↓ で行を移る。
//   下に階層がある行は、左の ▾ でたたむ
// 欄の外をクリックするか Esc で閉じる。プロジェクトごとのメモは、ターミナルの「メモ」タブ（state.note）

export interface NoteItem {
  id: string;
  text: string;
  /** 字下げの段（0 が一番上） */
  level: number;
  /** 下の階層をたたんでいるか */
  collapsed?: boolean;
}

export interface NoteFolder {
  id: string;
  name: string;
  /** 親のフォルダ。null は一番上 */
  parent: string | null;
  /** 中のフォルダをたたんでいるか */
  collapsed?: boolean;
}

export interface Note {
  id: string;
  /** 入れているフォルダ。null はフォルダの外 */
  folder: string | null;
  items: NoteItem[];
  /** 最後に書き換えた日時（UTC ミリ秒） */
  updated: number;
}

export interface NoteBook {
  folders: NoteFolder[];
  notes: Note[];
  /** 開いていたフォルダ（null は「すべて」）とメモ */
  openFolder?: string | null;
  openNote?: string;
}

const INDENT = 18;
const newItem = (level = 0, text = ''): NoteItem => ({ id: crypto.randomUUID(), text, level });
const newNote = (folder: string | null, items?: NoteItem[]): Note => ({ id: crypto.randomUUID(), folder, items: items ?? [newItem()], updated: Date.now() });

/** 以前の 1 枚だけのメモ（quickNotes）から作る */
export function notebookFrom(book: NoteBook | undefined, old: NoteItem[] | undefined): NoteBook {
  if (book) return book;
  return { folders: [], notes: old?.some((x) => x.text) ? [newNote(null, old)] : [] };
}

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
const isEmpty = (n: Note) => n.items.every((x) => !x.text.trim());
const titleOf = (n: Note) => n.items.find((x) => x.text.trim())?.text.trim() ?? '新規メモ';
const previewOf = (n: Note) => n.items.filter((x) => x.text.trim()).slice(1, 3).map((x) => x.text.trim()).join(' ');
const dateOf = (t: number) => {
  const d = new Date(t);
  const now = new Date();
  const p = (v: number) => String(v).padStart(2, '0');
  return d.toDateString() === now.toDateString() ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
};

export function setupQuickNotes(button: HTMLElement, load: () => NoteBook, save: (book: NoteBook) => void) {
  const panel = document.createElement('div');
  panel.className = 'quick-notes';
  panel.hidden = true;
  document.body.append(panel);
  let book: NoteBook = { folders: [], notes: [] };
  /** 開いているフォルダ（null は「すべて」） */
  let folder: string | null = null;
  let note: Note | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const persist = (now = false) => {
    clearTimeout(saveTimer);
    book.openFolder = folder;
    book.openNote = note?.id;
    if (now) save(book);
    else saveTimer = setTimeout(() => save(book), 500);
  };

  // ---- フォルダ ----
  const childrenOf = (parent: string | null) => book.folders.filter((f) => f.parent === parent).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  /** id のフォルダと、その中の全部のフォルダ */
  const descendants = (id: string): Set<string> => {
    const out = new Set([id]);
    for (let added = true; added; ) {
      added = false;
      for (const f of book.folders) if (f.parent && out.has(f.parent) && !out.has(f.id)) (out.add(f.id), (added = true));
    }
    return out;
  };
  const notesIn = (id: string | null) => (id === null ? book.notes : book.notes.filter((n) => descendants(id).has(n.folder ?? '')));

  /** 空のまま離れたメモは消す（Apple のメモと同じ） */
  const dropIfEmpty = (n: Note | null) => {
    if (n && isEmpty(n) && n !== note) book.notes = book.notes.filter((x) => x !== n);
  };

  const openNote = (n: Note | null) => {
    const prev = note;
    note = n;
    dropIfEmpty(prev);
    persist();
  };

  // ---- 描く ----
  const folderRows = (parent: string | null, depth: number): string =>
    childrenOf(parent)
      .map((f) => {
        const kids = childrenOf(f.id).length > 0;
        const fold = kids ? `<button type="button" class="qn-ffold" data-ffold="${f.id}">${f.collapsed ? '▸' : '▾'}</button>` : '<span class="qn-ffold"></span>';
        const count = notesIn(f.id).length;
        const row = `<div class="qn-folder${folder === f.id ? ' on' : ''}" data-folder="${f.id}" draggable="true" style="padding-left:${6 + depth * 14}px">${fold}<span class="qn-fname">📁 ${esc(f.name)}</span><span class="qn-count">${count || ''}</span></div>`;
        return row + (f.collapsed ? '' : folderRows(f.id, depth + 1));
      })
      .join('');

  const render = (focusId?: string, caret = -1) => {
    const list = notesIn(folder).sort((a, b) => b.updated - a.updated);
    const folderName = folder === null ? 'すべてのメモ' : (book.folders.find((f) => f.id === folder)?.name ?? '');
    const items = note?.items ?? [];
    const hidden = hiddenRows(items);
    panel.innerHTML = `
      <div class="qn-cols">
        <div class="qn-folders">
          <div class="qn-folder qn-all${folder === null ? ' on' : ''}" data-folder="">🗂 すべて<span class="qn-count">${book.notes.length || ''}</span></div>
          ${folderRows(null, 0)}
          <button type="button" class="qn-add-folder" title="今のフォルダの中に新しいフォルダを作る（「すべて」なら一番上）">＋ フォルダ</button>
        </div>
        <div class="qn-list">
          <div class="qn-list-head"><b>${esc(folderName)}</b><button type="button" class="qn-new" title="新しいメモ">＋</button></div>
          ${
            list
              .map(
                (n) =>
                  `<div class="qn-note${note === n ? ' on' : ''}" data-note="${n.id}" draggable="true"><div class="qn-title">${esc(titleOf(n))}</div><div class="qn-sub"><span>${dateOf(n.updated)}</span> ${esc(previewOf(n))}</div></div>`,
              )
              .join('') || '<div class="qn-empty">メモがありません。＋ で作る</div>'
          }
        </div>
        <div class="qn-body" title="Enter 次の行・Tab 字下げ・Shift+Tab 戻す・▾ でたたむ（全プロジェクト共通）">
          ${
            note
              ? items
                  .map((it, i) => {
                    if (hidden.has(i)) return '';
                    const fold = hasChildren(items, i) ? `<button type="button" class="qn-fold" data-i="${i}" title="${it.collapsed ? '開く' : 'たたむ'}">${it.collapsed ? '▸' : '▾'}</button>` : '<span class="qn-dot">•</span>';
                    return `<div class="qn-row${i === 0 ? ' qn-first' : ''}" style="padding-left:${it.level * INDENT}px">${fold}<input data-i="${i}" value="${esc(it.text)}" spellcheck="false" /></div>`;
                  })
                  .join('')
              : '<div class="qn-empty">左でメモを選ぶか、＋ で作る</div>'
          }
        </div>
      </div>`;
    if (focusId && note) {
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
    book = structuredClone(load());
    folder = book.openFolder && book.folders.some((f) => f.id === book.openFolder) ? book.openFolder : null;
    note = book.notes.find((n) => n.id === book.openNote) ?? notesIn(folder).sort((a, b) => b.updated - a.updated)[0] ?? null;
    const r = button.getBoundingClientRect();
    const w = Math.min(820, window.innerWidth - 16);
    panel.style.top = `${r.bottom + 4}px`;
    panel.style.width = `${w}px`;
    panel.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))}px`;
    panel.hidden = false;
    button.setAttribute('aria-pressed', 'true');
    render(note?.items.at(-1)?.id);
  };
  const close = () => {
    if (panel.hidden) return;
    if (note && isEmpty(note)) {
      book.notes = book.notes.filter((x) => x !== note);
      note = null;
    }
    persist(true);
    panel.hidden = true;
    button.setAttribute('aria-pressed', 'false');
  };

  const addNote = () => {
    const n = newNote(folder);
    book.notes.push(n);
    openNote(n);
    render(n.items[0].id);
  };

  const addFolder = (parent: string | null) => {
    const name = prompt('新しいフォルダの名前', '新規フォルダ')?.trim();
    if (!name) return;
    const f: NoteFolder = { id: crypto.randomUUID(), name, parent };
    book.folders.push(f);
    const p = book.folders.find((x) => x.id === parent);
    if (p) p.collapsed = false;
    folder = f.id;
    openNote(null);
    render();
  };

  /** フォルダの右クリック: 名前を変える・中にフォルダ・削除（中のメモとフォルダは 1 つ上へ） */
  const folderMenu = (f: NoteFolder, x: number, y: number) => {
    const menu = document.createElement('div');
    menu.className = 'qn-menu';
    menu.innerHTML = '<button data-a="rename">名前を変える</button><button data-a="sub">中にフォルダを作る</button><button data-a="del">削除（中のメモは 1 つ上へ）</button>';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    panel.append(menu);
    const done = () => menu.remove();
    menu.addEventListener('mousedown', (e) => e.stopPropagation());
    menu.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).dataset.a;
      done();
      if (a === 'rename') {
        const name = prompt('フォルダの名前', f.name)?.trim();
        if (name) f.name = name;
      } else if (a === 'sub') return addFolder(f.id);
      else if (a === 'del') {
        if (!confirm(`フォルダ「${f.name}」を削除しますか？（中のメモとフォルダは 1 つ上へ移します）`)) return;
        for (const n of book.notes) if (n.folder === f.id) n.folder = f.parent;
        for (const c of book.folders) if (c.parent === f.id) c.parent = f.parent;
        book.folders = book.folders.filter((x) => x !== f);
        if (folder === f.id) folder = f.parent;
      }
      persist();
      render();
    });
    setTimeout(() => document.addEventListener('mousedown', done, { once: true }));
  };

  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  // 欄の外をクリックしたら閉じる
  document.addEventListener('mousedown', (e) => {
    if (!panel.hidden && !panel.contains(e.target as Node) && !button.contains(e.target as Node)) close();
  });

  panel.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const fold = t.closest<HTMLButtonElement>('.qn-fold');
    if (fold && note) {
      const it = note.items[Number(fold.dataset.i)];
      it.collapsed = !it.collapsed;
      persist();
      return render(it.id);
    }
    const ffold = t.closest<HTMLElement>('[data-ffold]');
    if (ffold) {
      const f = book.folders.find((x) => x.id === ffold.dataset.ffold);
      if (f) f.collapsed = !f.collapsed;
      persist();
      return render();
    }
    if (t.closest('.qn-new')) return addNote();
    if (t.closest('.qn-add-folder')) return addFolder(folder);
    const fr = t.closest<HTMLElement>('[data-folder]');
    if (fr) {
      folder = fr.dataset.folder || null;
      const first = notesIn(folder).sort((a, b) => b.updated - a.updated)[0] ?? null;
      openNote(first);
      return render();
    }
    const nr = t.closest<HTMLElement>('[data-note]');
    if (nr) {
      openNote(book.notes.find((n) => n.id === nr.dataset.note) ?? null);
      render(note?.items.at(-1)?.id);
    }
  });

  panel.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement;
    const fr = t.closest<HTMLElement>('[data-folder]');
    const f = fr?.dataset.folder ? book.folders.find((x) => x.id === fr.dataset.folder) : null;
    if (f) {
      e.preventDefault();
      const r = panel.getBoundingClientRect();
      return folderMenu(f, e.clientX - r.left, e.clientY - r.top);
    }
    const nr = t.closest<HTMLElement>('[data-note]');
    const n = nr ? book.notes.find((x) => x.id === nr.dataset.note) : null;
    if (n) {
      e.preventDefault();
      if (!isEmpty(n) && !confirm(`メモ「${titleOf(n)}」を削除しますか？`)) return;
      book.notes = book.notes.filter((x) => x !== n);
      if (note === n) note = null;
      persist();
      render();
    }
  });

  // ドラッグ: メモ・フォルダをフォルダ（か「すべて」= フォルダの外）に落とす
  let dragging: { kind: 'note' | 'folder'; id: string } | null = null;
  panel.addEventListener('dragstart', (e) => {
    const t = e.target as HTMLElement;
    if (t.dataset.note) dragging = { kind: 'note', id: t.dataset.note };
    else if (t.dataset.folder) dragging = { kind: 'folder', id: t.dataset.folder };
    e.dataTransfer?.setData('text/plain', '');
  });
  panel.addEventListener('dragover', (e) => {
    const fr = (e.target as HTMLElement).closest<HTMLElement>('[data-folder]');
    if (!dragging || !fr) return;
    // フォルダを自分の中には入れない
    if (dragging.kind === 'folder' && fr.dataset.folder && descendants(dragging.id).has(fr.dataset.folder)) return;
    e.preventDefault();
    panel.querySelectorAll('.qn-drop').forEach((x) => x.classList.remove('qn-drop'));
    fr.classList.add('qn-drop');
  });
  panel.addEventListener('drop', (e) => {
    const fr = (e.target as HTMLElement).closest<HTMLElement>('[data-folder]');
    if (!dragging || !fr) return;
    e.preventDefault();
    const to = fr.dataset.folder || null;
    if (dragging.kind === 'note') {
      const n = book.notes.find((x) => x.id === dragging!.id);
      if (n) n.folder = to;
    } else {
      const f = book.folders.find((x) => x.id === dragging!.id);
      if (f && !(to && descendants(f.id).has(to))) f.parent = to;
    }
    dragging = null;
    persist();
    render();
  });
  panel.addEventListener('dragend', () => {
    dragging = null;
    panel.querySelectorAll('.qn-drop').forEach((x) => x.classList.remove('qn-drop'));
  });

  // ---- 本文 ----
  const touched = () => {
    if (note) note.updated = Date.now();
    persist();
    // 一覧の題名と日時だけ書き換える（本文の入力欄は作り直さない。打っている途中のカーソルが飛ばないように）
    const row = note && panel.querySelector(`[data-note="${note.id}"]`);
    if (row && note) {
      row.querySelector('.qn-title')!.textContent = titleOf(note);
      row.querySelector('.qn-sub')!.innerHTML = `<span>${dateOf(note.updated)}</span> ${esc(previewOf(note))}`;
    }
  };

  panel.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement;
    if (!note || input.dataset.i === undefined) return;
    note.items[Number(input.dataset.i)].text = input.value;
    touched();
  });

  panel.addEventListener('keydown', (e) => {
    const input = e.target as HTMLInputElement;
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      return close();
    }
    if (input.tagName !== 'INPUT' || !note) return;
    // ショートカット（Space で再生など）に渡さない
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) return;
    const items = note.items;
    const i = Number(input.dataset.i);
    const it = items[i];
    const visible = [...panel.querySelectorAll<HTMLInputElement>('.qn-body input[data-i]')].map((x) => Number(x.dataset.i));
    const pos = visible.indexOf(i);
    if (e.key === 'Enter') {
      e.preventDefault();
      // カーソルより後ろの文字は次の行へ。下の階層が開いていれば、その最初の子として入れる
      const rest = input.value.slice(input.selectionStart ?? input.value.length);
      it.text = input.value.slice(0, input.selectionStart ?? input.value.length);
      const child = hasChildren(items, i) && !it.collapsed;
      const at = child ? i + 1 : subtreeEnd(items, i);
      const n = newItem(child ? it.level + 1 : it.level, rest);
      items.splice(at, 0, n);
      touched();
      render(n.id, 0);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // 下の階層ごと字下げする（1 つ上の行より 2 段以上は深くしない）
      const end = subtreeEnd(items, i);
      const prev = i > 0 ? items[i - 1].level : -1;
      const d = e.shiftKey ? (it.level > 0 ? -1 : 0) : it.level <= prev ? 1 : 0;
      if (!d) return;
      for (let j = i; j < end; j++) items[j].level += d;
      touched();
      render(it.id, input.selectionStart ?? -1);
    } else if (e.key === 'Backspace' && input.value === '' && items.length > 1) {
      e.preventDefault();
      // 空の行を消す。下の階層は 1 段上げて残す
      const end = subtreeEnd(items, i);
      for (let j = i + 1; j < end; j++) items[j].level = Math.max(0, items[j].level - 1);
      items.splice(i, 1);
      const back = items[visible[pos - 1] ?? 0] ?? items[0];
      touched();
      render(back.id);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const to = visible[pos + (e.key === 'ArrowUp' ? -1 : 1)];
      if (to === undefined) return;
      e.preventDefault();
      render(items[to].id, input.selectionStart ?? -1);
    }
  });
}
