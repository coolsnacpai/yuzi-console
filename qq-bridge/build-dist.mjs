// 打包安装包：dist\玉子控制台-安装包\
// 结构：安装玉子控制台.exe + yuzu.ico + payload\bridge\* + payload\app\* + 安装说明.txt + version.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP = 'D:\\DeepSeek test\\玉子软件开发';
const DIST = 'D:\\DeepSeek test\\玉子项目开发-安装测试\\01-安装包';
const DEPLOY = 'D:\\DeepSeek test\\玉子项目开发-安装测试\\02-部署工具';
const VERSION = (() => {
  try {
    const m = fs.readFileSync(path.join(ROOT, 'console.mjs'), 'utf8').match(/const VERSION = '([^']+)'/);
    return m ? m[1] : '0.0.0';
  } catch { return '0.0.0'; }
})();

// 需要随包走的程序文件（不含 .env / data / inbox / logs）
const BRIDGE_FILES = [
  'console.mjs', 'bot.mjs', 'memory.mjs', 'backup.mjs', 'qz_watch.mjs', 'qz_browser.mjs',
  'cdp.mjs', 'tools.mjs', 'say.mjs', 'sync.mjs', 'packs.mjs', 'docfmt.mjs', 'autostart.bat', 'napcat-env.ps1', 'should-retry.ps1', 'kill-napcat-qq.ps1', 'qq-bridge-startup.vbs', 'dsh-startup.vbs',
  'persona.md', 'README.md', '.env.example', 'start.bat',
];
const BRIDGE_DIRS = ['web', 'plugins'];

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) n += copyDir(s, d);
    else { copyFile(s, d); n++; }
  }
  return n;
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. 主程序
copyFile(path.join(APP, '安装玉子控制台.exe'), path.join(DIST, '安装玉子控制台.exe'));
copyFile(path.join(APP, 'assets', 'yuzu.ico'), path.join(DIST, 'yuzu.ico'));

// 2. payload/bridge
let n = 0;
for (const f of BRIDGE_FILES) {
  const s = path.join(ROOT, f);
  if (fs.existsSync(s)) { copyFile(s, path.join(DIST, 'payload', 'bridge', f)); n++; }
}
for (const d of BRIDGE_DIRS) n += copyDir(path.join(ROOT, d), path.join(DIST, 'payload', 'bridge', d));
// 工具：ffmpeg 太大，不打包（安装向导里一键下载）
fs.mkdirSync(path.join(DIST, 'payload', 'bridge', 'tools'), { recursive: true });

// 3. payload/app（含托盘源码与检查脚本，部署器要在目标机重新编译）
copyFile(path.join(APP, '玉子控制台.exe'), path.join(DIST, 'payload', 'app', '玉子控制台.exe'));
copyFile(path.join(APP, 'assets', 'yuzu.ico'), path.join(DIST, 'payload', 'app', 'yuzu.ico'));
// 部署器重编译托盘时要按 APP\assets\yuzu.ico 找图标，这里多放一份
fs.mkdirSync(path.join(DIST, 'payload', 'app', 'assets'), { recursive: true });
copyFile(path.join(APP, 'assets', 'yuzu.ico'), path.join(DIST, 'payload', 'app', 'assets', 'yuzu.ico'));
copyFile(path.join(APP, 'assets', 'yuzu.png'), path.join(DIST, 'payload', 'app', 'assets', 'yuzu.png'));
copyDir(path.join(APP, 'src'), path.join(DIST, 'payload', 'app', 'src'));
for (const f of ['检查安装.ps1','检查安装.bat']) { if (fs.existsSync(path.join(APP,f))) copyFile(path.join(APP,f), path.join(DIST, 'payload', 'app', f)); }
copyDir(DEPLOY, path.join(DIST, 'deploy'));
for (const f of ['部署.ps1','deploy-core.mjs','给新电脑的说明.md']) { const s=path.join(DEPLOY,f); if (fs.existsSync(s)) copyFile(s, path.join(DIST, f)); }

// 4. 说明 + 版本
fs.writeFileSync(path.join(DIST, 'version.json'), JSON.stringify({ version: VERSION, at: new Date().toISOString() }, null, 2), 'utf8');
fs.writeFileSync(path.join(DIST, '安装说明.txt'), `玉子控制台 v${VERSION} · 安装说明

1. 双击「安装玉子控制台.exe」
2. 点「开始安装」
3. 装完会自动启动托盘（右下角绿色小图标），双击图标打开控制台

装到哪：
  D:\\DeepSeek test\\qq-bridge     程序本体
  D:\\DeepSeek test\\玉子软件开发   托盘 exe + 备份 + 文档
  C:\\DSH\\                        启动脚本（无空格路径，计划任务要用）

会动系统的地方（都可还原）：
  · 注册表 HKCU\\...\\Run 两个启动项：QQBridge_AutoStart / DSH_AutoStart
  · 计划任务 QQBridge-KeepAlive（每 2 分钟自检）
  · 桌面 + 开始菜单快捷方式

不会覆盖：已有的 .env、data\\（配置和聊天记忆都保留）

装完第一次要做的事：
  1. 控制台「设置 → 配置(.env)」填 DEEPSEEK_API_KEY 和 OWNER_QQ
  2. 首页 NapCat 卡点「启动」→ 手机 QQ 扫码（掉登录时才会要）
  3. 设置页「🩺 自检」跑一次，缺什么点「一键修复」
`, 'utf8');

const bytes = (function size(p) {
  let s = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    s += e.isDirectory() ? size(q) : fs.statSync(q).size;
  }
  return s;
})(DIST);

console.log(JSON.stringify({ ok: true, dist: DIST, version: VERSION, bridgeFiles: n, sizeMB: +(bytes / 1048576).toFixed(2) }, null, 2));
