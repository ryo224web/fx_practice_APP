#!/bin/zsh
# FX Practice のサーバー（5173 番）を止める
pids=$(lsof -ti tcp:5173 -sTCP:LISTEN 2>/dev/null)
[[ -n "$pids" ]] && kill $pids
exit 0
