# 玉子控制台（Yuzi Console）

一个跑在自己电脑上的「QQ 助手控制台」：把 NapCat（QQ 协议端）、玉子 bot（聊天主进程）、空间监听、DeepSeek 账号状态、无头 Edge 这些零散的东西，收进一个本地网页 + 托盘图标里统一管。

> 只在自己机器上跑，监听 `127.0.0.1`，不对外开端口，不收集任何数据。
> QQ 自动化本身违反平台用户协议，有被限制/封号的风险，**请只用自己的小号，别拿主号玩**。

---

## 它现在能干什么

| 模块 | 能力 |
|---|---|
| QQ 聊天 | 私聊自动回（DeepSeek 模型 + 人格文件），支持图片理解、语音转文字、工具调用（跑命令、读写文件、联网搜索） |
| 群聊 | 群白名单：填群号即自动回话，可选「每句都回 / 只回 @ / 不回」，带冷却 |
| 好友 | 新好友申请推给你审，`/同意` `/拒绝` 一条指令处理；好友白名单内的人也能聊 |
| QQ 空间 | 你发说说 → 自动点赞 + 评论（无头 Edge + CDP 真点击，绕开 qzonetoken 风控） |
| 日程/天气 | 每天定时把群消息和私聊汇总成待办；天气走 Open-Meteo，零 key |
| 人格调试 | 记忆包（`.yzm`）/ 性格包（`.yzp`）导入导出，也吃 `.docx` `.doc` `.md` `.txt`；一键让 AI 重写语气 |
| 账号管理 | 改昵称、签名、头像、发说说，全部在控制台点 |
| 运维 | 服务启停/重启、日志、二维码热刷新、一键自检修复、环境自检、备份回滚、DeepSeek 余额与峰谷价格 |
| 安装 | `安装玉子控制台.exe` 图形向导，自动装快捷方式、写启动脚本、注册开机自启；也可用 `deploy/` 里的部署器装到全新电脑 |

---

## 架构

```
手机 QQ ⇄ 腾讯服务器 ⇄ NapCat（QQ 协议端，WS :3001）
                             ⇅
                    玉子 bot（Node，:3008 单实例锁）
                     ├─ memory.mjs   跨渠道共享记忆（data/brain/messages.jsonl）
                     ├─ tools.mjs    工具层（shell/文件/搜索/空间…）
                     ├─ packs.mjs    记忆包 / 性格包
                     └─ DeepSeek API（deepseek-flash，支持看图）

玉子控制台 console.mjs（Node，:3210）
  ├─ 自己开一条 WS 连 :3001（不抢 bot 的消息）
  ├─ 读 data/*.json、eve 日志、进程与端口探活
  └─ web/index.html（原生 HTML/JS，零构建）

托盘 玉子控制台.exe（C# / WinForms）
  ├─ 启动/唤起 Edge --app 窗口
  ├─ 掉登录弹气泡、白屏自愈（CDP 查 DOM）
  └─ 页面里点「导出」→ 弹系统另存为
```

为什么不用 Electron：150–250MB 安装包 + 200MB+ 内存，和「精简」目标冲突。Node 起本地服务 + Edge `--app` 窗口，装完约 1.4MB。

---

## 目录

```
qq-bridge/          主程序（Node，零第三方依赖）
  bot.mjs           QQ 聊天主进程：收消息 → DeepSeek → 回消息；工具调用循环
  console.mjs       控制台 HTTP 服务 + API（/api/status、/api/chat、/api/groups…）
  memory.mjs        共享记忆库（跨 GUI 会话 / QQ 同一份）
  packs.mjs         记忆包、性格包、风格档案
  docfmt.mjs        零依赖 docx/doc/rtf 读写（手写 zip + deflate）
  tools.mjs         模型可调用的工具集
  qz_watch.mjs      空间监听（轮询说说 → 点赞/评论）
  qz_browser.mjs    无头 Edge + CDP 的页面操作
  cdp.mjs           Chrome DevTools Protocol 迷你客户端
  backup.mjs        备份 / 回滚
  web/index.html    控制台界面（原生 JS）
tray/               托盘与安装器（C#，csc 直接编译）
docs/               使用手册、可行性分析、新用户引导
dist/               已打包好的发布 zip（已脱敏）
```

---

## 快速开始

### 用安装包（推荐）

1. 下载 `dist/玉子控制台-v0.3.15-public.zip` 解压，双击 **`01-安装包/安装玉子控制台.exe`**；
2. 安装器会：复制程序 → 写启动脚本到 `C:\DSH` → 建桌面/开始菜单快捷方式 → 注册开机自启 → 起托盘；
3. 装完打开控制台，在「设置」里把 `.env` 填好（见下），点「重启对应服务」；
4. 首次用 QQ 会出二维码，手机小号扫一下（NapCat 支持密码快速登录，可在 `.env` 填 `NAPCAT_QUICK_PASSWORD`）。

### 用源码

```bat
cd qq-bridge
copy .env.example .env
rem 编辑 .env：OWNER_QQ / DEEPSEEK_API_KEY / NAPCAT_WS / BOT_QQ
node bot.mjs         & rem 聊天主进程
node console.mjs     & rem 控制台 http://127.0.0.1:3210
```

托盘：`csc /target:winexe /out:玉子控制台.exe /win32icon:tray\assets\yuzu.ico tray\YuzuTray.cs`（.NET Framework 4.x 自带编译器）。

---

## 配置（.env）

| 键 | 说明 |
|---|---|
| `OWNER_QQ` | 你的 QQ 号（只有这个人能指挥玉子） |
| `BOT_QQ` | 玉子小号的 QQ 号 |
| `DEEPSEEK_API_KEY` | DeepSeek 密钥（必填） |
| `MODEL` | 默认 `deepseek-flash`（支持看图）；`deepseek-chat` 更快但纯文本 |
| `NAPCAT_WS` / `NAPCAT_TOKEN` | NapCat 的 OneBot WS 地址与 token |
| `WATCH_GROUPS` | 群白名单（逗号分隔，控制台里加也行） |
| `GROUP_REPLY` | `all` / `mention` / `off` |
| `FRIEND_REPLY` / `FRIEND_COOLDOWN` | 好友是否回、冷却秒数 |
| `MAX_MSG_PER_MIN` | 每分钟最多发几条（防刷屏） |
| `WEATHER_ON` / `WEATHER_AT` / `WEATHER_CITY` | 天气推送 |
| `SUMMARY_AT` | 每日汇总时间，默认 `21:30` |
| `NAPCAT_QUICK_ACCOUNT` / `NAPCAT_QUICK_PASSWORD` | NapCat 免扫码快速登录（可选，明文存盘请自斟酌） |

`.env` 已在 `.gitignore` 里，别提交。

---

## 安全与合规

- 发布包里**不含任何密钥、QQ 号、密码、token**；`.env` 需要你自己填。
- 控制台只监听 `127.0.0.1`，不要把 3210/3001 暴露到公网。
- QQ 自动化违反腾讯用户协议，存在封号风险；本项目仅供个人研究与自用，**不要用于群发、刷量、营销**。
- 抓取/存档公众号、空间等内容时，版权归原作者，别二次分发。

## 已知限制

- 群列表依赖 NapCat 缓存，偶尔只显示部分群，手填群号即可；
- 空间点赞/评论依赖无头 Edge 登录态，Edge 登录过期要重新扫码；
- 语音转文字依赖 NapCat 的 `fetch_ptt_text`，部分格式不支持；
- 只测过 Windows 10/11 + Node 18+ + Edge。

## 许可

个人使用随意。要商用或二次分发，先自己确认合规性——代码里不替你做这个决定。
