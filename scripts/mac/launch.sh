#!/bin/zsh
# FX Practice を起動する（Mac mini）。すでに動いていればブラウザで開くだけ。
# サーバーは裏で動き続ける。止めるときは stop.sh（「FX Practice を終了」）。
# 保存データはアドレスごとに分かれるので、ポートは必ず 5173 にする。

cd "${0:A:h}/../.." || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
URL=http://localhost:5173
LOG="$HOME/Library/Logs/fx-practice.log"

running() { curl -s --max-time 1 "$URL" | grep -q '<title>FX Practice</title>'; }

if ! running; then
  if lsof -ti tcp:5173 -sTCP:LISTEN >/dev/null 2>&1; then
    osascript -e 'display alert "FX Practice を起動できません" message "5173 番を別のアプリが使っています。そのアプリを終了してから、もう一度開いてください。"'
    exit 1
  fi
  nohup npx vite --port 5173 --strictPort >"$LOG" 2>&1 &
  for i in {1..75}; do running && break; sleep 0.2; done
fi

if running; then
  # NO_OPEN=1 のときはブラウザを開かない（動作確認用）
  if [[ -z "$NO_OPEN" ]]; then open "$URL"; fi
else
  osascript -e 'display alert "FX Practice を起動できませんでした" message "記録: ~/Library/Logs/fx-practice.log"'
  exit 1
fi
