#!/bin/bash
# 心枕 · QQ 掉线自动重登
# 每分钟检查一次：NapCat 在线就不动；掉线了尝试重启容器（容器带 ACCOUNT 环境变量，
# 重启会用 -q 走快速登录）。等扫码期间不反复重启，免得把二维码刷掉。
set -u
LOG=/var/log/xinzhen-qqguard.log
STATE=/var/lib/xinzhen-qqguard
CONTAINER=napcat
CFG=/opt/napcat/config/onebot11_2821744520.json

mkdir -p "$STATE"
TOKEN=$(python3 -c "import json;print(json.load(open('$CFG'))['network']['httpServers'][0]['token'])" 2>/dev/null)
[ -z "$TOKEN" ] && { echo "$(date '+%F %T') 读不到 OneBot 令牌，跳过" >> "$LOG"; exit 0; }

now=$(date +%s)
last_restart=$(cat "$STATE/last_restart" 2>/dev/null || echo 0)
was_online=$(cat "$STATE/was_online" 2>/dev/null || echo 0)

resp=$(curl -s -m 8 -X POST http://127.0.0.1:3000/get_login_info \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}')

if echo "$resp" | grep -q '"user_id"'; then
  echo 1 > "$STATE/was_online"
  # 在线时清掉「等扫码」的冷却
  rm -f "$STATE/waiting_since"
  exit 0
fi

echo 0 > "$STATE/was_online"

# 掉线了：距上次重启不到 10 分钟就别再折腾
if [ $((now - last_restart)) -lt 600 ]; then
  exit 0
fi

# 第一次发现掉线：先记下时间，等 60 秒再动手（可能只是抖动）
if [ ! -f "$STATE/down_since" ]; then
  echo "$now" > "$STATE/down_since"
  echo "$(date '+%F %T') 检测到掉线，观察中" >> "$LOG"
  exit 0
fi
down_since=$(cat "$STATE/down_since")
if [ $((now - down_since)) -lt 60 ]; then
  exit 0
fi

# 刚重启过、现在是在等扫码 → 30 分钟内不再重启，让用户有时间扫
if [ -f "$STATE/waiting_since" ]; then
  if [ $((now - $(cat "$STATE/waiting_since"))) -lt 1800 ]; then
    exit 0
  fi
fi

st=$(curl -s -m 8 -X POST http://127.0.0.1:3000/get_status -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}')

echo "$(date '+%F %T') 掉线超过 60 秒，重启容器尝试快速登录（was_online=$was_online）" >> "$LOG"
docker restart "$CONTAINER" >/dev/null 2>&1
echo "$now" > "$STATE/last_restart"
rm -f "$STATE/down_since"

# 起完后 25 秒看结果
sleep 25
resp2=$(curl -s -m 8 -X POST http://127.0.0.1:3000/get_login_info \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}')
if echo "$resp2" | grep -q '"user_id"'; then
  echo "$(date '+%F %T') 快速登录成功" >> "$LOG"
  echo 1 > "$STATE/was_online"
else
  echo "$(date '+%F %T') 快速登录没成，转为等扫码（30 分钟内不再重启）" >> "$LOG"
  date +%s > "$STATE/waiting_since"
fi

# 日志瘦身
if [ -f "$LOG" ] && [ "$(stat -c %s "$LOG")" -gt 262144 ]; then
  tail -500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
