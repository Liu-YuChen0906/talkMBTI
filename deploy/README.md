# Ubuntu + 公网 IP 部署

没有注册或邀请码。以下步骤在你的 Ubuntu 服务器上执行；本次没有连接或修改远程服务器。

## 1. 准备

安装 **Node.js 22.16 或更新的 LTS 版本（推荐 24）**，使用 Node 官方提供的安装方式。Ubuntu 默认 apt 的 Node 版本可能过旧。无 npm 第三方依赖。

```sh
node --version
command -v node
sudo apt update
sudo apt install nginx git
sudo useradd --system --user-group --home-dir /opt/talkmbti --shell /usr/sbin/nologin talkmbti
sudo git clone https://github.com/Liu-YuChen0906/talkMBTI.git /opt/talkmbti
```

先在自己的电脑把本次代码提交、推送到仓库，再 clone。如果用户或目录已存在，跳过对应创建命令。代码目录可以保持 root 所有且普通用户可读，运行用户只需写入 `/var/lib/talkmbti`。

## 2. 设置密钥和限制

```sh
sudo install -m 600 /opt/talkmbti/deploy/server.env.example /etc/talkmbti.env
sudo nano /etc/talkmbti.env
```

填写 `AI_API_KEY` 和 `PUBLIC_ORIGIN=http://你的公网IP`；其余值可先保持默认。使用非 80 端口时，来源必须包括该端口。不要把服务器密钥提交到 Git。

## 3. 启动进程

```sh
sudo cp /opt/talkmbti/deploy/talkmbti.service /etc/systemd/system/talkmbti.service
sudo systemctl daemon-reload
sudo systemctl enable --now talkmbti
sudo systemctl status talkmbti
```

若 `command -v node` 不是 `/usr/bin/node`，先修改 service 的 `ExecStart`。不要使用只在个人 shell 中初始化的 nvm 路径。运行 **一个 systemd 实例**，不使用 npm 集群或多个副本；SQLite 必须存放本机磁盘，不能使用网络盘。

## 4. Nginx 转发

新服务器上用本配置作为默认站点；如果已有网站，合并配置并处理默认站点冲突。

```sh
sudo cp /opt/talkmbti/deploy/nginx.conf /etc/nginx/sites-available/talkmbti
sudo ln -s /etc/nginx/sites-available/talkmbti /etc/nginx/sites-enabled/talkmbti
# 编辑 /etc/nginx/sites-enabled/default，将其默认站点配置停用，避免两个 default_server。
sudo nginx -t
sudo systemctl reload nginx
```

在云服务器安全组放行 TCP 80（以及已有 SSH 端口），**不要放行 3000**。Node 只监听本机，Nginx 覆盖 `X-Real-IP`；`TRUST_PROXY=true` 仅在此拓扑下启用。不读取客户端自带的 `X-Forwarded-For`。

访问 `http://你的公网IP`。检查响应的访客 Cookie；连续刷新不能重置额度，开始一次测试后新建应受到限制，但续答仍可用。

HTTP 可以试运行，但回答和访客 Cookie 在网络中没有加密；公开收集真实回答前应配置浏览器信任的 HTTPS（IP 证书或后续域名）。HTTPS 后把 `PUBLIC_ORIGIN` 改为准确的 `https://…` 并重启，这会自动启用 Secure Cookie。不提供绕过证书警告的步骤。

## 默认限制与调整

| 范围 | 默认限制 |
|---|---|
| 浏览器身份 | 每天 1 次新测试、250,000 Token、28 次模型请求 |
| IPv4 地址 / IPv6 /64 网段 | 每天 8 次新测试、1,500,000 Token、224 次模型请求、32 个新访客身份 |
| 每次测试 | 最多 28 次模型请求，包含失败重试 |
| 全站 | 每天 500 次新测试、10,000,000 Token、10,000 个新访客身份；最多 3 个同时分析 |
| 每次回答/模型输出 | 1000 个 Unicode 字符 / 2500 个输出 Token |
| 高频操作 | 浏览器超过 15 次或网络超过 60 次请求触发验证码；每天同网络第 4 个新访客也需验证 |
| 硬限流 | 浏览器 60、网络 180 次请求（当前及上一个分钟桶，最长 120 秒）；验证码也不能解除 |

每天北京时间零点重置日额度。处于执行中的请求继续计入请求开始时的日期。匿名 Cookie 是服务端签名的，不能自行改成新的有效身份；清 Cookie 仍受网络及全站限制。共享网络可能误伤多人，可按真实流量提高 `IP_DAILY_*`。

Token：先以输入 JSON 的 UTF-8 字节数＋512 个框架余量＋最大输出 Token 预留。模型返回有效 `usage.total_tokens` 后按实际结算，包括返回了 usage 但判断 JSON 无效的情况。超时、请求失败、缺失 usage、服务崩溃时保留全额预留，避免未知收费被免费重试。调用次数永不退回。上限是应用限制而非供应商账单保证；模型使用量异常超过预留也如实计入。

本地六位图片验证码只增加普通自动脚本的成本，可被 OCR 或人工代答绕过；访客、网络、全站硬额度不依赖验证码，验证成功也不能提高它们。匿名用户换网络/设备仍可能获得新额度，无法严格识别自然人。网站流量增大后可换用专业验证码或边缘防护。

## 运维与更新

```sh
sudo journalctl -u talkmbti -n 100 --no-pager
cd /opt/talkmbti
sudo git pull --ff-only
sudo systemctl restart talkmbti
```

修改 `/etc/talkmbti.env` 后重启即可。额度、签名密钥、访谈状态均在 `/var/lib/talkmbti/access.sqlite` 中；重启不清零。请备份整个数据目录：简单方式是短暂停止服务再复制目录，SQLite 的 WAL 文件不能在运行中随意删除或只备份主文件。

过期验证码、短期限流窗口、32 天前的日额度会自动清理；访客身份和访谈长期保留，管理员需自行安排保留期限及备份。不要删除数据库来恢复额度，这也会丢失身份和访谈访问权。

旧版只存 JSON 的访谈没有浏览器归属，升级后不会自动公开给任何匿名访客；原文件仍保留，可在本机查看或导出。新访谈在数据库中原子保存，同时继续维护每维 JSON 文件作为可读副本。
