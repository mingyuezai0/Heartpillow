#!/bin/bash
# 重建 NapCat 容器（保留账号与密码自动登录配置）
# 用法：改掉下面的账号/密码，然后 sudo bash xinzhen-napcat-run.sh
set -e

ACCOUNT="${ACCOUNT:-1234567890}"          # ← 机器人 QQ 号
QUICK_PASSWORD="${QUICK_PASSWORD:-...}"   # ← NapCat 的快速登录密码（泄漏就换掉）

docker rm -f napcat >/dev/null 2>&1 || true
docker run -d --name napcat --restart always \
  -e TZ=Asia/Shanghai \
  -e ACCOUNT="$ACCOUNT" \
  -e NAPCAT_QUICK_PASSWORD="$QUICK_PASSWORD" \
  -e NAPCAT_UID=0 -e NAPCAT_GID=0 \
  -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 6099:6099 \
  -v /opt/napcat/config:/app/napcat/config \
  -v /opt/napcat/qq:/app/.config/QQ \
  mlikiowa/napcat-docker:latest
