# 大肥鱼 QQ 桥接

手机 QQ ⇄ NapCat（登录小号）⇄ 本程序 ⇄ DeepSeek API

```
你手机QQ ──腾讯── 小号(NapCat) ──OneBot WS── bot.mjs ──HTTPS── api.deepseek.com
                                              └── data/memory.json 记忆
```

## 目录

| 文件 | 作用 |
| --- | --- |
| `bot.mjs` | 主程序，零依赖 |
| `persona.md` | 人设，改这个文件就能改口吻（发 `/persona` 热重载） |
| `.env` | 你的 QQ 号和 API Key，**别外传** |
| `start.bat` | 双击启动 |
| `data/memory.json` | 聊天记忆，删掉即失忆 |

---

## 阶段一：装 NapCat 并登录小号

1. 下载 [NapCat.Shell.Windows.OneKey.zip](https://github.com/NapNeko/NapCatQQ/releases/latest)（不到 1MB）。
2. 解压到**纯英文路径**，例如 `D:\NapCat`（中文/空格路径容易出幺蛾子）。
3. 运行 `NapCatInstaller.exe`，等它下完 QQ，会生成 `NapCat.XXXX.Shell` 目录。
4. 进那个目录，双击 `napcat.bat`。
5. 控制台会刷出一行：
   `[info] [NapCat] [WebUi] WebUi User Panel Url: http://127.0.0.1:6099/webui?token=xxxxx`
   复制整个 URL 到浏览器打开。
6. WebUI 里点 `QRCode`，用**小号**的手机 QQ 扫码登录。
7. 登录后 token 会刷新，去控制台或手机端看新 token，重新进 WebUI，按提示**改个密码**（不改的话很多功能被禁用）。

✅ 验收：控制台出现 `账号 xxxxx 登录成功`，WebUI 顶部能看到小号头像。

---

## 阶段二：开一个 WebSocket 服务端

WebUI → 左侧「网络配置」→ 新建 → 选 **WebSocket 服务端**（正向 WS）：

| 字段 | 填什么 |
| --- | --- |
| 名称 | `bridge` |
| 启用 | 勾上（保存时也要勾「保存时启用」） |
| Host | `127.0.0.1` |
| 端口 | `3001` |
| 消息格式 | `array` |
| Token | 留空（本机访问，先不折腾） |
| 心跳 | `30000` |

保存。浏览器打开 `http://127.0.0.1:3001` 如果显示 404 或握手失败，说明端口活着，正常。

> 手动改文件也行：`config/onebot11_<小号QQ>.json` 的 `network.websocketServers` 里加这一项。WebUI 更不容易写错，建议用 WebUI。

---

## 阶段三：填 `.env`

用记事本打开 `.env`，填两行：

```
OWNER_QQ=你自己的QQ号
DEEPSEEK_API_KEY=sk-你的key
```

✅ 验收：文件里没有中文字符、没有多余空格。

---

## 阶段四：启动并测试

1. 确认 NapCat 还开着（小号在线）。
2. 双击 `start.bat`。
3. 看到：

```
[xx:xx:xx] 连接 NapCat： ws://127.0.0.1:3001/
[xx:xx:xx] ✅ 已连接 NapCat，等待消息
```

4. 用**你自己的 QQ** 给**小号**发一句「在吗」。

✅ 验收：手机几秒内收到回复，终端打印 `←` 和 `→` 两行。

---

## 阶段五：常驻（可选）

- **开机自启**：`Win+R` → `shell:startup` → 把 `start.bat` 的快捷方式丢进去。
- **NapCat 也自启**：同目录 `napcat.bat` 同样做个快捷方式。
- 建议给这台 PC 设成不休眠（电源选项 → 从不睡眠），否则断线。

---

## 排错对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `ECONNREFUSED 127.0.0.1:3001` | WS 服务端没开 / 端口不对 | 回阶段二检查，确认「启用」勾了 |
| 连接后立刻 401/断开 | Token 不匹配 | `.env` 里 `NAPCAT_TOKEN` 和 WebUI 里填的一致 |
| 连上了但发消息没反应 | 白名单不匹配 | 检查 `OWNER_QQ` 是不是你发消息那个号 |
| 回复「脑子卡了一下」 | API Key 错 / 余额不足 / 网络 | 看终端日志里的 `API 4xx` |
| 一条都不回，日志显示忽略 | 你在用小号给自己发？或发的是群消息 | 本程序只处理「私聊 + 白名单」 |
| NapCat 掉线 | QQ 被踢 / 网络断 | 重启 `napcat.bat` 重新扫码 |

---

## 红线（再念一遍）

- 只用小号，主号别登录。
- 不主动加人、不进群、不群发。
- 限速默认 6 条/分钟，别调太高。
- 出现验证码/人脸，立刻停手，隔天再说。

## 工具能力（v2）

QQ 那头的大肥鱼现在能真的干活，不再只会聊天：

| 工具 | 作用 |
|---|---|
| pc_shell | 在这台电脑执行 PowerShell（默认工作目录：桌面），危险命令有拦截 |
| pc_ls / pc_read / pc_write | 看目录、读文件、写文件 |
| qq_send_file | 把文件或整个文件夹打包 zip 直接发到主人 QQ |
| web_search | 联网搜索（Bing/百度/DuckDuckGo 轮询） |
| web_fetch | 抓网页正文 |
| set_avatar / set_nickname / set_signature / post_qzone | 改这个号的头像、昵称、签名、发说说 |

注意：QQ 端记忆存在 data/memory.json，和 DSH 桌面会话的历史是两套，别指望它记得 GUI 里聊过什么。

## 跨渠道共享记忆（v3）

QQ 端和电脑端（DSH 会话）现在共用一份记忆，不再各记各的。

| 文件 | 作用 |
|---|---|
| `memory.mjs` | 共享记忆读写：append / recent / clearChannel / trim（上限 800 条自动裁剪） |
| `sync.mjs` | 读 DSH 会话文件（`~/.dsh/sessions/--<编码工作区>--/session-*/session.v4.jsonl.zstd`），把电脑端对话导入共享记忆 |
| `data/brain/messages.jsonl` | 唯一的记忆库，每行 `{t,ch,role,text}`，`ch` 是 `gui` 或 `qq` |
| `data/brain/state.json` | 每个会话已同步到的 seq，避免重复导入 |

工作方式：

- QQ 收到一条消息 → 先 `syncOnce()` 把电脑端新对话导入（20 秒节流）→ 把「跨渠道记忆」片段塞进 system prompt（最近 16 条，电脑端）→ 回答后把这一问一答写回 `ch=qq`。
- 电脑端（GUI）侧：`~/.dsh/AGENTS.md` 里写了规则，涉及 QQ 时会去读 `data/brain/messages.jsonl` 的最近 30 条。
- 手动同步：`node sync.mjs`；`/status` 会显示两边各多少条；`/reset` 只清 `ch=qq`，不动电脑端记忆。

技术坑（已解决）：DSH 的会话文件是**多个 zstd 帧首尾拼接**，`zlib.zstdDecompressSync` 只解第一帧，必须按 magic `28 B5 2F FD` 切帧逐段解压；且文件在 `session-<uuid>\` 子目录里，不是工作区目录的一层。

## 开机自启（v4）

两个启动项写在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`（不需要管理员）：

| 注册表值 | 指向 | 行为 |
|---|---|---|
| `DSH_AutoStart` | `dsh-startup.vbs` | 延迟 15 秒，启动 `D:\DeepSeek harness\DeepSeek Harness.exe` |
| `QQBridge_AutoStart` | `qq-bridge-startup.vbs` | 延迟 20 秒，跑 `autostart.bat` |

`autostart.bat` 的判定顺序（幂等，重复执行不会起第二份）：

1. 3001 已在监听 → 不拉 NapCat；否则查 QQ 进程，没在跑就 `NapCatWinBootMain.exe 10001`（免扫码快登小号）。
2. 最多 120 秒等 `127.0.0.1:3001` LISTENING，超时也继续。
3. `node bot.mjs`（bot 自己有单实例锁，占 `127.0.0.1:3008`，重复启动会自己退出）。
4. 9333 没监听就拉无头 Edge（`--headless=new --remote-debugging-port=9333 --user-data-dir=data\edge-profile`），点赞/评论要靠它。
5. `node qz_watch.mjs`（空间监听，锁在 `127.0.0.1:3009`）。

日志：`data\boot.log`（启动过程）、`data\bot.log`（bot 输出）、`data\qzone.log`（空间监听）、`data\vbs-error.log`（启动失败才有）。

取消自启：双击 `remove-autostart.bat`。

坑：`.bat` / `.vbs` 必须是 **CRLF** 换行，否则 cmd 会按行撕裂执行；VBScript 里拼引号别用 `""""`，用 `Chr(34)` 才稳。

## QQ 空间自动点赞 + 评论（v5）

腾讯给 `emotion_cgi_re_feeds`（评论）和 `internal_dolike_app`（点赞）加了 **qzonetoken** 风控：用 Cookie + `g_tk` 直接打接口，点赞返回 `{"ret":-2,"msg":"error param"}`、评论返回 `{"ret":1001,"msg":"对不起，系统繁忙"}`；页面上也拿不到 token（`g_qzonetoken` 为 null，没有下发 token 的脚本）。

改为**无头 Edge 里真人在场式点击**：

```bat
node qz_watch.mjs               :: 常驻，默认一天拉一次（.env 里 QZ_POLL_MS 可改，单位毫秒）
node qz_watch.mjs --test        :: 只对最新一条试一次
node qz_browser.mjs <tid> --like-only
node qz_browser.mjs <tid> "评论内容"
```

链路：NapCat `get_cookies` 拿 Cookie → CDP `Network.setCookies` → 打开 `https://user.qzone.qq.com/<uin>/mood/<tid>` → 找到 `mood_v6` iframe 的 executionContextId → 在 iframe 里点 `a.qz_like_btn`（文案变「取消赞」算成功）/ 展开 `.comments_box .textinput_default` → 焦点落到 `.qz-poster-editor-cont [contenteditable]` → **逐字符 `Input.dispatchKeyEvent`** 输入（用 `Input.insertText` 不会生成「发表」按钮）→ 点 `a.btn-post`。

前提：无头 Edge 必须活着（CDP 端口 9333）。沙箱里起 Chromium 会因命名管道被禁而 `FATAL mojo ... 拒绝访问`，所以起 Edge 要脱离沙箱；登录态靠 Cookie 注入，不需要扫码。

残留：`qz_watch.mjs` 里 `doLikeApi` / `doCommentApi` 是退役的纯接口实现，留着对照用，不再被调用。


## 好友自动回复（v4）
- 收到好友申请：私聊主人「QQ 号 + 昵称 + 验证消息」，回 `/同意 <QQ>` 或 `/拒绝 <QQ>`。
- 通过后自动写入 `data/friends.json` 白名单；每次连上 NapCat 也会把好友列表并进白名单。
- 白名单好友私聊：玉子会自动回，**每人一分钟最多一句**（`FRIEND_COOLDOWN=60`）。
- `/好友` 查看白名单；`/待审` 看待批申请。
- 好友对话没有人设变化：玉子永远是主人的女仆，只是对朋友不许叫「主人」、不许碰工具和隐私。
