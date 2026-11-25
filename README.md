# 糯叽机 云端中继 (nuojiji-relay)

> 糯叽机专用后端消息生成。

把「调用 AI 生成」从手机搬到一个**永远在线的后端**。这样你切后台、锁屏、被系统杀进程，
这次 AI 回复也会在服务端跑完，等你回来时消息已经在那儿了 —— 不再需要和系统抢「保活」。

> **自带后端 (BYOB)**：你部署自己的实例、填自己的 AI key，
> 在糯叽机 APP 里指向自己的后端 URL。**糯叽机作者的服务器不碰你的任何数据或 key。**
> 这和 APP 本身「自带 API key (BYOK)」的理念一致。

---

## 🚀 一键部署（推荐，零命令行）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wcl20071005/nuojiji-relay)

**三步搞定（全程网页点击，不用装任何东西）：**

1. 点上面的 **Deploy to Cloudflare** 按钮 → 用 Cloudflare 账号登录（没有就免费注册）
2. 在部署页：
   - **RELAY_SECRET** 填一个你自己定的密码（随便一串字符，等下 App 里要填一样的）
   - 其他留空即可（KV 存储会自动创建；PWA 推送密钥后端会自动生成；iOS 推送默认走糯叽机中转）
   - 点 **Deploy / 部署**
3. 部署完拿到网址 `https://nuojiji-relay.xxx.workers.dev` → 打开糯叽机 App → 设置 → API 设置 → **云端中继**：
   - **中继地址** = 那个网址
   - **中继密钥** = 你刚填的 RELAY_SECRET
   - 打开开关 → 点「测试连接」变绿 → 完成 ✅

> 想要更省钱/无 CPU 时长限制 → 见下面 VPS/Docker。绝大多数人用一键部署就够。

> ## ⚠️ 大陆用户必看：不要直接用 `*.workers.dev` 地址
>
> `*.workers.dev` 域名在中国大陆**被墙**。后果很隐蔽：
> - **推送照样能弹**（推送是后端服务器发给 Apple/Google 推送服务，不经过你手机连墙外域名）；
> - **但消息点进去是空的** —— 因为手机要直连你的 `workers.dev` 地址去「拉取」消息正文，这一步被墙挡住了。
>
> 这就是「**收到推送、点进聊天却没有消息**」的根本原因。解决办法二选一：
> 1. **给 Worker 绑一个自有域名**（Cloudflare 面板 → 你的 Worker → Settings → Domains & Routes → 添加自定义域名），
>    把 App 里的「中继地址」改成那个自有域名（确保该域名在大陆可访问）；
> 2. 或走下面的 **VPS/Docker** 部署，部署在大陆可访问的主机上（带 HTTPS）。
>
> App 在启动时会探测中继是否可达，连不上会弹「云端中继连不上」提示。

---

## 🔄 如何更新到最新版（重要！）

一键部署时，Cloudflare 会把本仓库 **fork 到你自己的 GitHub**，你的中继跟踪的是**你那个 fork**，不是本仓库。
所以作者更新代码后，**不会自动同步到你的中继**——你要手动同步一次（30 秒，全程网页点击）：

1. 打开你 fork 的仓库（GitHub 上 `你的用户名/nuojiji-relay`）
2. 仓库页面顶部会显示 **「This branch is N commits behind …」** → 点旁边的 **「Sync fork」** → **「Update branch」**
3. 你的 fork 更新后，Cloudflare 会**自动重新部署**你的中继（约 1-2 分钟）
4. 完成 ✅ 中继已是最新（推送修复、新功能等都会生效）

> 看不到 "Sync fork" 按钮 = 你的 fork 已经是最新，无需操作。
> 更新中继**不需要**重装糯叽机 App / 不影响你的聊天数据。

---

## 它怎么工作

```
手机点发送
  └─ POST /generate  {messages, settings(含你的AI key), meta}   ← 立即返回，不等
                          │
                  后端服务端调你的 AI API（切后台也跑完）
                          │
                  结果存进短期 outbox 队列  +  发推送叫醒手机
                          │
手机（收推送 / 回前台 / 定时轮询）
  └─ GET /outbox  →  写进聊天记录  →  POST /ack 删除
```

- 后端**除了几十分钟的临时 outbox，不持久化任何聊天内容**。
- 推送只是「叫醒」信号，丢了也不丢消息 —— 手机下次拉取会补回（轮询兜底，大陆也能用）。
- 同一条请求 (`requestId`) 只会被处理一次。

---

## 进阶：命令行部署 Cloudflare Workers（懂技术的才需要，一般用上面的一键部署）

```bash
git clone <你 fork 的仓库>
cd nuojiji-relay
npm install

# 1. 建 KV namespace（存 outbox + 推送订阅）
npx wrangler kv namespace create OUTBOX
#   把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]] id

# 2. 设密钥（手机端要填一样的值）
npx wrangler secret put RELAY_SECRET
#   随便一个长随机串，例：openssl rand -hex 32

# 3.（可选）开 Web Push —— 不开就只走轮询
npx web-push generate-vapid-keys      # 得到 public/private
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT  # mailto:you@example.com

# 4. 部署
npx wrangler deploy
```

部署后得到 `https://nuojiji-relay.<你的子域>.workers.dev`，这就是要填进 APP 的**中继 URL**。

---

## 部署方式二：VPS / Docker（长驻 Node 进程，无 CPU 时长限制）

```bash
git clone <你 fork 的仓库>
cd nuojiji-relay
npm install
cp .env.example .env
#   编辑 .env：至少填 RELAY_SECRET；要持久化 outbox 设 RELAY_STORE=sqlite
node server.js
#   默认 http://localhost:8787
```

Docker：
```bash
docker build -t nuojiji-relay .
docker run -d -p 8787:8787 \
  -e RELAY_SECRET=你的密钥 \
  -e RELAY_STORE=memory \
  nuojiji-relay
```

⚠️ **务必挂 HTTPS**（Caddy / Nginx / Cloudflare Tunnel 反代）——AI key 是在请求体里传给后端的，
明文 HTTP 会泄露。填进 APP 的 URL 用你的 HTTPS 域名。

---

## 在 APP 里启用

糯叽机 → 设置 → API 设置 → 「云端中继 (BYOB)」：
- **中继地址**：你的后端 URL（上面拿到的）
- **中继密钥**：和后端 `RELAY_SECRET` 一致
- 打开「启用云端中继」开关
- 点「测试连接」，绿了就成

---

## 环境变量一览

| 变量 | 必填 | 说明 |
|------|------|------|
| `RELAY_SECRET` | ✅ | 手机↔后端共享密钥，两端一致 |
| `RELAY_STORE` | | `memory`(默认) / `sqlite`(持久，需 better-sqlite3) |
| `RELAY_SQLITE_PATH` | | sqlite 文件路径，默认 `./outbox.db` |
| `PORT` | | Node 端口，默认 8787 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | | 开 Web Push 才需要；不填只走轮询 |
| `RELAY_ALLOW_PRIVATE_HOST` | | `=1` 放行内网/本机 AI 地址（本地调试或同机部署 AI 时用） |

---

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（设置页测连接），无需鉴权 |
| POST | `/generate` | 提交生成，202 立即返回；重复 requestId → 409 |
| GET | `/outbox?inboxId=&since=&scan=` | 拉取已生成结果（scan=1 额外做 KV 前缀扫描兜底，scan=0 只读索引） |
| POST | `/ack` | `{inboxId, ids}` 确认删除 |
| GET | `/api/push/vapid-key` | 取 VAPID 公钥 |
| POST | `/api/push/subscribe` | 注册推送订阅 |
| DELETE | `/api/push/unsubscribe` | 退订 |
| POST | `/proactive/register` | 注册主动消息（含手机端拼好的 prompt 模板） |
| POST | `/proactive/sync-messages` | 增量同步滑窗上下文 + lifeState |
| POST | `/proactive/unregister` | 取消主动消息 |
| GET | `/proactive/status?inboxId=` | 查主动消息状态（不含敏感内容） |
| GET/POST | `/config` | 读 / 写主动消息检测间隔 `{ tickMinutes }`（1~60） |

除 `/health` 外都需 `Authorization: Bearer <RELAY_SECRET>`。

---

## 主动消息（角色 App 关闭也能找你）

开启后，**App 完全关闭/被杀时**，后端按定时任务（cron，每分钟一次）重算每个角色的「想找你冲动值」，
命中就**实时调你的 AI** 生成一条最新的主动消息，存进 outbox + 发推送叫醒手机。

- **决策算法**（什么时候该主动发）在后端，是**纯数值逻辑**（沉默时长、时段、心情、承诺到点…），开源可见。
- **提示词文本和构建逻辑不在后端代码里**：手机在前台时把拼好的完整 system prompt（含 `{{RECENT_MESSAGES}}` / `{{IMPULSE_REASON}}` 占位符）注册给后端，后端只做字符串替换再发出去。**GitHub 仓库里看不到任何提示词/人设/越狱框架。**
- 你的人设、最近聊天上下文、AI key 会存在**你自己的后端**（KV/sqlite/内存）—— 这是「App 关闭也能主动生成」的物理前提，作者服务器仍然不碰。
- Cloudflare 用 Cron Triggers（`wrangler.toml` 已配 `crons=["* * * * *"]`）；Node 用内置 node-cron。
- **KV 免费额度**（每天写入 1000 次 / 列出 1000 次 / 读取 10 万次）：
  - 空转轮次（没有角色要发）**零写入**；默认**每 5 分钟**检测一次主动消息。
  - 检测间隔可在 App「API 设置 → 云端中继 → 云端检查频率」直接改（1~30 分钟），App 会写进中继，不用动 CF 面板。
    部署者想锁死也可在 CF 面板 → Worker → 变量 加 `PROACTIVE_TICK_MINUTES=N`（优先于 App 设置）。
  - 手机定时拉消息只读索引、不做 KV「列出」；只有启动 / 回前台才做一次兜底扫描。旧版 App 不带参数时，同一 inbox 最多每 30 分钟扫一次（`OUTBOX_SCAN_MINUTES` 可改）。
- ⚠️ Workers 有 CPU 时长/调用配额，适合中小规模；角色数量多、想要更稳的定时主动 → 用 VPS/Docker 长驻进程。

---

## 安全说明

- 单一静态密钥、无轮换。对**个人自用**足够；密钥泄露 = 别人能花你的 AI key，请妥善保管、走 HTTPS。
- 后端会拒绝把请求转发到内网 / 云元数据地址（防 SSRF），除非显式开 `RELAY_ALLOW_PRIVATE_HOST=1`。
- outbox 默认 45 分钟 TTL；手机离线超过这个时长，那条结果会被清掉（视为丢失）。

---

## 路线图

- **Phase 1（已完成）**：服务端跑完手机发起的回复 + outbox 拉取 + Web Push/轮询。
- **Phase 2（已完成）**：后端 cron 定时主动生成（角色主动找你，App 关闭也能用），提示词不进仓库。
- **后续**：iOS APNs / Android FCM 原生推送（`src/push/apns.js` `fcm.js` 已留 stub），让 App 被杀时也能弹推送（当前靠轮询兜底）。
