#!/bin/bash
# 由 xinzhen-bridge 以 sudo 调用（掉线自救）：重启 NapCat，登录失效时把二维码刷出来
# 装到 /usr/local/bin/xinzhen-napcat-oob.sh，并在 /etc/sudoers.d/xinzhen-bridge 里放：
#   www-data ALL=(root) NOPASSWD: /usr/local/bin/xinzhen-napcat-oob.sh
docker restart napcat >/dev/null 2>&1
sleep 25
if docker exec napcat sh -lc 'test -f /app/napcat/cache/qrcode.png' 2>/dev/null; then
  docker cp napcat:/app/napcat/cache/qrcode.png /opt/xinzhen/qqlogin.png 2>/dev/null || true
  chown www-data:www-data /opt/xinzhen/qqlogin.png 2>/dev/null || true
fi
