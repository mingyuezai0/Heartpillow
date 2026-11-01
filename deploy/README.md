# 服务端部署（Linux 服务器 + 浏览器访问）

心枕本体是**一个 HTML 文件**，但要让它在服务器上跑得完整（页面关着也回消息、定时计划、B 站代跑、QQ 图片代取），
还需要三个小服务和一个 nginx 站点。

```
浏览器 ──> nginx :7863 ──┬─ /            静态：心枕.html
                         ├─ /v1/         模型网关（wb2api 之类，可选）
                         ├─ /qq/api/     ┐
                         ├─ /qq/ws       ├ NapCat（OneBot 11，Docker）
                         ├─ /webui/      ┘
                         ├─ /qq/bridge/  ┐ 常驻客户端 xinzhen-bridge（代替页面）
                         ├─ /bili/       ┘ 同一个服务，B 站由它代跑
                         └─ /qq/img/     图片代取 xinzhen-imgproxy
```

## 目录里有什么

| 文件 | 作用 |
|---|---|
| `install.sh` | 一键部署（拷文件、装服务、配 nginx、放最小 sudo 权限） |
| `bridge.py` | 常驻客户端：长连 NapCat、收消息、替页面回消息、跑定时计划、代发 B 站请求、掉线自救 |
| `imgproxy.py` | 图片白名单代取（QQ / B 站图床），避免浏览器混内容 |
| `systemd/xinzhen-bridge.service` | 常驻客户端的服务定义（**要改里面的 token 和域名**） |
| `systemd/xinzhen-imgproxy.service` | 图片代取的服务定义 |
| `nginx/xinzhen.conf` | 站点配置（7863 端口，全部同源，没有跨域） |
| `scripts/xinzhen-napcat-run.sh` | 起 NapCat Docker 容器（**要改账号和快速登录密码**） |
| `scripts/xinzhen-napcat-oob.sh` | 掉线自救用：重启容器 + 刷登录二维码（只给这一个脚本开 sudo） |

## 部署

```bash
# 1. 基础环境
sudo apt update && sudo apt install -y nginx python3 docker.io
sudo systemctl enable --now nginx docker

# 2. 一键装（把心枕.html 一起带过来）
sudo bash install.sh /path/to/心枕.html

# 3. 起 NapCat（先改脚本里的 ACCOUNT / QUICK_PASSWORD）
sudo bash scripts/xinzhen-napcat-run.sh
curl -s http://127.0.0.1:3000/get_login_info -H 'Authorization: Bearer <你的token>' | head -c 200

# 4. 常驻客户端填 token
sudo sed -i 's|XZ_TOKEN=.*|XZ_TOKEN=<你的 NapCat token>|; s|XZ_SELF_HOSTS=.*|XZ_SELF_HOSTS=<你的公网IP或域名>|' \
  /etc/systemd/system/xinzhen-bridge.service
sudo systemctl daemon-reload && sudo systemctl restart xinzhen-bridge

# 5. 自检
curl -s http://127.0.0.1:9100/status
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7863/
```

浏览器打开 `http://<IP>:7863/`，设置里填模型接口（地址 / 密钥 / 模型名），
外接里连 QQ（token 同上）、点「登录」扫 B 站二维码。

## 自检清单

```bash
systemctl status xinzhen-bridge xinzhen-imgproxy nginx
journalctl -u xinzhen-bridge -n 50 --no-pager
curl -s http://127.0.0.1:9100/status            # connected / loginOk / lastError
curl -s http://127.0.0.1:9100/bili/status       # B 站登录态
```

| 现象 | 原因 |
|---|---|
| `loginOk:false`，日志里有「快速登录错误：你的用户身份已失效」 | QQ 登录态过期，点应用里的二维码重扫；或改 `NAPCAT_QUICK_PASSWORD` 后重建容器 |
| QQ 收不到消息但 `connected:true` | NapCat 的事件端口没通：确认 `-p 127.0.0.1:3001:3001` 且 nginx `/qq/ws` 是 upgrade |
| B 站接口 `code:-412` | 风控：删掉 `/var/lib/xinzhen-bridge/bili.json` 里的 cookie，让程序重新取 buvid 后重试 |
| 页面提示「通道没通」 | 常驻客户端没在跑，或 nginx 没配 `/qq/bridge/`、`/bili/` |

## 安全

- NapCat 的 3000/3001 只绑 `127.0.0.1`，对外只有 nginx 那一个端口；
- 常驻客户端以 `www-data` 跑，唯一特权是「重启 NapCat 容器」这一个 sudo 脚本；
- 备份导出**不包含**模型接口密钥、NapCat token、B 站登录 cookie。
