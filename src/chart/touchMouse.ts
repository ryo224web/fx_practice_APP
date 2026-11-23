/**
 * iPad の Safari は、マウスをつないでいても、チャートの上で押す・ドラッグを touch（pointerType "touch" と touchstart など）で送り、
 * mousedown・mouseup・click はタップが終わった後にしか出さない（ドラッグでは出さない。2026-11-23 に public/evtest.html で確かめた）。
 * さらにチャートの部品が touchend を止めるので、その後の mousedown なども届かず、図形を引けなかった。
 *
 * そこで、チャートの上（キャンバス）での touch の押す・動かす・離すを、マウスの合図にしてチャートの要素に送る
 * （図形・注文の線・測る線は、今までどおり mouse の合図で動く）。
 * - 送り先はチャートの要素そのもの（中のキャンバスには送らない）。チャートの部品がその合図でも動いて、二重に動かないように
 * - 押した合図を図形などが受け取った（stopPropagation した）ときは、その指の touch をチャートの部品に渡さない（チャートを動かさない）。
 *   受け取らなかったときは、今までどおり部品がチャートを動かす
 * - 離した後に Safari が出す mousedown・click などは止める（二重にならないように。ダブルクリックは図形の側で間隔から見分ける）
 * Mac のマウス（pointerType "mouse"）は何もしない
 */
export function bridgeTouchToMouse(el: HTMLElement) {
  let id: number | null = null;
  let consumed = false;
  let bridged = false;
  let moved = false;
  let start = { x: 0, y: 0 };

  const send = (type: string, e: PointerEvent) =>
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: e.clientX,
        clientY: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
        button: 0,
        buttons: type === 'mousedown' || type === 'mousemove' ? 1 : 0,
        detail: 1,
        shiftKey: e.shiftKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      }),
    );

  el.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse' || !e.isPrimary || !(e.target instanceof HTMLCanvasElement)) return;
      id = e.pointerId;
      bridged = true;
      moved = false;
      start = { x: e.clientX, y: e.clientY };
      // 押した合図が window まで届けば、誰も受け取っていない（図形などは受け取ると stopPropagation する）
      let reached = false;
      const probe = () => (reached = true);
      window.addEventListener('mousedown', probe);
      send('mousedown', e);
      window.removeEventListener('mousedown', probe);
      consumed = !reached;
    },
    true,
  );
  window.addEventListener('pointermove', (e) => {
    if (e.pointerId !== id) return;
    if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5) moved = true;
    send('mousemove', e);
  });
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = null;
    send('mouseup', e);
    if (!moved && e.type === 'pointerup') send('click', e);
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);

  // 図形などが受け取った指は、チャートの部品に渡さない（チャートが一緒に動かないように。画面のスクロールも止める）
  const block = (e: TouchEvent) => {
    if (!bridged || !consumed) return;
    e.stopPropagation();
    if (e.cancelable) e.preventDefault();
  };
  el.addEventListener('touchstart', block, { capture: true, passive: false });
  el.addEventListener('touchmove', block, { capture: true, passive: false });
  el.addEventListener(
    'touchend',
    (e) => {
      if (!bridged) return;
      // 離した後の mousedown・mouseup・click・dblclick を出させない（もう送ってある）
      if (e.cancelable) e.preventDefault();
      if (consumed) e.stopPropagation();
      if (e.touches.length === 0) bridged = false;
    },
    { capture: true, passive: false },
  );
  el.addEventListener('touchcancel', () => (bridged = false), true);
}
