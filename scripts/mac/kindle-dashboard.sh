#!/bin/zsh
# Kindle のダッシュボードのサーバー（server/kindleServer.ts）を、Mac mini にログインしている間いつも動かす（launchd。2026-11-27）。
# FX Practice とは別に動くので、FX Practice を閉じていても Kindle の画面は新しくなる。止まっても launchd が起動し直す。
#
#   zsh scripts/mac/kindle-dashboard.sh install     入れて起動する（npm run kindle-agent -- install）
#   zsh scripts/mac/kindle-dashboard.sh restart     起動し直す（server/ を変えたあと）
#   zsh scripts/mac/kindle-dashboard.sh uninstall   止めて外す
#   zsh scripts/mac/kindle-dashboard.sh status      動いているか
# 記録は ~/Library/Logs/kindle-dashboard.log
set -e
LABEL=local.kindle-dashboard
PLIST=~/Library/LaunchAgents/$LABEL.plist
REPO=${0:a:h:h:h}
NODE=$(command -v node)
LOG=~/Library/Logs/kindle-dashboard.log
DOMAIN=gui/$(id -u)

case "${1:-status}" in
  install)
    mkdir -p ~/Library/LaunchAgents
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$REPO/server/kindleServer.ts</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "入れました: $PLIST（記録は $LOG）"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "起動し直しました"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "外しました"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =|last exit" || echo "入っていません"
    tail -3 "$LOG" 2>/dev/null || true
    ;;
  *)
    echo "使い方: $0 install|restart|uninstall|status"; exit 1 ;;
esac
