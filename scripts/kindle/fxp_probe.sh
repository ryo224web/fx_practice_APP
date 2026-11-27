#!/bin/sh
# Name: FX 充電の調べ
# Author: fx_practice
#
# 充電を止める設定項目があるかを調べるだけのスクリプト（何も書き換えない。2026-11-27）。
# 本の一覧のこのファイルをタップすると、Kindle の一番上に fxp_probe.txt を書く。

OUT=/mnt/us/fxp_probe.txt
{
  echo "== $(date) $(cat /etc/prettyversion.txt 2>/dev/null)"
  echo "== lipc powerd"
  for p in battLevel isCharging battVoltage battTemperature batteryCapacity; do
    echo "$p=$(lipc-get-prop com.lab126.powerd $p 2>&1)"
  done
  echo "== power_supply"
  for d in /sys/class/power_supply/*; do
    [ -d "$d" ] || continue
    echo "-- $d"
    for f in "$d"/*; do
      [ -f "$f" ] && echo "$(basename "$f") [$(ls -l "$f" | cut -c1-10)] = $(head -c 120 "$f" 2>/dev/null | tr '\n' ' ')"
    done
  done
  echo "== names with charg / batt / max77696 under /sys (depth 6)"
  find /sys -maxdepth 6 \( -iname '*charg*' -o -iname '*batt*' -o -iname '*max77696*' \) 2>/dev/null | head -200
  echo "== charger devices (files)"
  for d in $(find /sys/devices -maxdepth 6 -type d \( -iname '*charg*' -o -iname '*max77696*' \) 2>/dev/null | head -20); do
    echo "-- $d"
    for f in "$d"/*; do
      [ -f "$f" ] && echo "$(basename "$f") [$(ls -l "$f" | cut -c1-10)] = $(head -c 80 "$f" 2>/dev/null | tr '\n' ' ')"
    done
  done
  echo "== end"
} > "$OUT" 2>&1
