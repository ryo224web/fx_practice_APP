#!/bin/sh
# Name: FX 充電を止めるテスト
# Author: fx_practice
#
# 充電を止める設定（/sys/devices/system/wario_charger/wario_charger0/allow_charging）が効くかを試す（2026-11-27）。
# ケーブルをつないで充電している状態で、本の一覧のこのファイルをタップする。
#   今の値を記録 → allow_charging を 0 にする → 15 秒待って充電が止まったかを記録 → 必ず元の値に戻す → 戻ったかを記録
# 結果は Kindle の一番上の fxp_chargetest.txt。画面にも結果を 1 行出す。

C=/sys/devices/system/wario_charger/wario_charger0
B=/sys/class/power_supply/max77696-battery
OUT=/mnt/us/fxp_chargetest.txt
export PATH="/mnt/us/libkh/bin:$PATH"

state() {
  echo "$1: allow_charging=$(cat $C/allow_charging 2>&1) charging=$(cat $C/charging 2>&1) debounce=$(cat $C/debounce_charging 2>&1) status=$(cat $B/status 2>&1) current_now=$(cat $B/current_now 2>&1) capacity=$(cat $B/capacity 2>&1) isCharging=$(lipc-get-prop com.lab126.powerd isCharging 2>&1)"
}

{
  echo "== $(date)"
  ls -l $C/ 2>&1
  ls -l /sys/devices/system/wario_battery/wario_battery0/ 2>&1 | head -20
  state before
  orig=$(cat $C/allow_charging 2>/dev/null)
  [ -z "$orig" ] && orig=1
  # 何があっても元に戻す
  trap 'echo "$orig" > $C/allow_charging 2>/dev/null' EXIT INT TERM
  if echo 0 > $C/allow_charging 2>&1; then
    echo "wrote 0"
  else
    echo "cannot write allow_charging"
  fi
  sleep 15
  state "after 0 (15s)"
  echo "$orig" > $C/allow_charging 2>&1 && echo "restored $orig"
  sleep 15
  state "after restore (15s)"
  echo "== end"
} > "$OUT" 2>&1

res=$(grep -E '^(before|after)' "$OUT" | sed 's/current_now=/I=/' | cut -c1-200 | tr '\n' ' ')
command -v fbink >/dev/null 2>&1 && fbink -q -y 5 "charge test done. see fxp_chargetest.txt" >/dev/null 2>&1
