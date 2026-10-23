#!/bin/zsh
# FX Practice を起動する（Mac mini）。すでに動いていれば開くだけ。
# Chrome があれば、タブもアドレスバーも無い Chrome のアプリのウィンドウで開く（もう開いていれば、そのウィンドウを前に出す。
# 同じプロジェクトを 2 つのウィンドウで開くと、保存がぶつかるため）。Chrome が無ければ、いつものブラウザで開く。
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

CHROME="/Applications/Google Chrome.app"

# もう開いている FX Practice のウィンドウを前に出す。あれば 0 で終わる
# （初めてのときだけ「FX Practice が Google Chrome を操作しようとしています」と聞かれる。許可しないと毎回新しいウィンドウになる）
focus_existing() {
  pgrep -xq "Google Chrome" || return 1
  osascript <<APPLESCRIPT 2>/dev/null | grep -q yes
tell application "Google Chrome"
  repeat with w in windows
    repeat with t in tabs of w
      if URL of t starts with "$URL" then
        set index of w to 1
        activate
        return "yes"
      end if
    end repeat
  end repeat
  return "no"
end tell
APPLESCRIPT
}

if running; then
  # NO_OPEN=1 のときはブラウザを開かない（動作確認用）
  if [[ -n "$NO_OPEN" ]]; then exit 0; fi
  if [[ -d "$CHROME" ]]; then
    focus_existing || open -na "$CHROME" --args --app="$URL"
  else
    open "$URL"
  fi
else
  osascript -e 'display alert "FX Practice を起動できませんでした" message "記録: ~/Library/Logs/fx-practice.log"'
  exit 1
fi
