#!/bin/bash
# 心枕 服务端一键部署（Debian/Ubuntu）
#
# 做什么：
#   1. 把单文件应用放到 /opt/xinzhen（网页本体）
#   2. 装常驻客户端 xinzhen-bridge（代替页面：收消息、回消息、跑计划、代跑 B 站）
#   3. 装图片代取 xinzhen-imgproxy（QQ / B 站图床白名单）
#   4. 装 nginx 站点（默认 7863 端口，同源反代，浏览器里没有跨域）
#
# 用法：
#   sudo bash install.sh /path/to/心枕.html
#
set -e
[ "$(id -u)" = "0" ] || { echo "请用 sudo 跑"; exit 1; }

APP_SRC="${1:-./心枕.html}"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "== 1/5 目录 =="
mkdir -p /opt/xinzhen /opt/napcat/config /opt/napcat/qq /var/lib/xinzhen-bridge
cp -f "$APP_SRC" /opt/xinzhen/心枕.html
cp -f /opt/xinzhen/心枕.html /opt/xinzhen/index.html

echo "== 2/5 常驻客户端与图片代取 =="
cp -f "$HERE/bridge.py" /opt/xinzhen/bridge.py
cp -f "$HERE/imgproxy.py" /opt/xinzhen/imgproxy.py
cp -f "$HERE/systemd/xinzhen-bridge.service" /etc/systemd/system/
cp -f "$HERE/systemd/xinzhen-imgproxy.service" /etc/systemd/system/
cp -f "$HERE/scripts/xinzhen-napcat-oob.sh" /usr/local/bin/
chmod 755 /usr/local/bin/xinzhen-napcat-oob.sh
chown -R www-data:www-data /opt/xinzhen /var/lib/xinzhen-bridge

echo "== 3/5 给它重启容器的最小权限 =="
cat > /etc/sudoers.d/xinzhen-bridge <<'EOF'
www-data ALL=(root) NOPASSWD: /usr/local/bin/xinzhen-napcat-oob.sh
EOF
chmod 440 /etc/sudoers.d/xinzhen-bridge
visudo -c >/dev/null

echo "== 4/5 nginx =="
cp -f "$HERE/nginx/xinzhen.conf" /etc/nginx/sites-available/xinzhen
ln -sf /etc/nginx/sites-available/xinzhen /etc/nginx/sites-enabled/xinzhen
nginx -t && systemctl reload nginx

echo "== 5/5 起服务 =="
systemctl daemon-reload
systemctl enable --now xinzhen-imgproxy
systemctl enable --now xinzhen-bridge

echo
echo "好了。接下来手动做三件事："
echo "  1) 起 NapCat：sudo bash $HERE/scripts/xinzhen-napcat-run.sh（先改里面的账号/密码）"
echo "  2) 改 /etc/systemd/system/xinzhen-bridge.service 里的 XZ_TOKEN / XZ_SELF_HOSTS，然后 systemctl restart xinzhen-bridge"
echo "  3) 浏览器开 http://<你的IP>:7863/ ，设置里填模型接口，外接里连 QQ、扫码登录 B 站"
echo
curl -s -o /dev/null -w 'index = %{http_code}\n' http://127.0.0.1:7863/ || true
