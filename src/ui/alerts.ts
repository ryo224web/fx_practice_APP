// アラート（ライブの間だけ。2026-11-26）: 鳴らすと、FP の中で音を鳴らして画面に知らせを出し、
// 開発サーバーに頼んで Mac の通知も出す（/api/notify。FP を見ていなくても気づけるように）。
// 何を見て鳴らすか（水平線の 🔔・RCI の 0 付近）は main.ts。

let audio: AudioContext | null = null;

/** 「ピロン」と 2 回鳴らす（音のファイルは使わない） */
export function beep() {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime;
    for (const [i, f] of [880, 1320, 880, 1320].entries()) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.16 + (i >= 2 ? 0.25 : 0);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.15);
    }
  } catch {
    // 音が出せなくても知らせと通知は出す
  }
}

/**
 * アラートを鳴らす。key は同じアラートを 2 つの画面（Mac mini と iPad など）で開いていても、Mac の通知を 1 回にするための目印
 */
export function fireAlert(title: string, body: string, key: string, show: (msg: string) => void) {
  beep();
  show(`🔔 ${title}　${body}`);
  void fetch('/api/notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, key }),
  }).catch(() => {});
}
