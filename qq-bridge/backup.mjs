// 玉子 · 备份/回滚（零依赖，用系统 tar.exe）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PARENT = path.dirname(ROOT);
const BASE = path.basename(ROOT); // qq-bridge
const DEST = 'D:\\DeepSeek test\\玉子项目开发-安装测试\\04-备份';

const INCLUDE = [
  `${BASE}/.env`,
  `${BASE}/persona.md`,
  `${BASE}/bot.mjs`,
  `${BASE}/console.mjs`,
  `${BASE}/memory.mjs`,
  `${BASE}/tools.mjs`,
  `${BASE}/qz_browser.mjs`,
  `${BASE}/qz_watch.mjs`,
  `${BASE}/cdp.mjs`,
  `${BASE}/sync.mjs`,
  `${BASE}/autostart.bat`,
  `${BASE}/web`,
  `${BASE}/data/brain`,
  `${BASE}/data/friends.json`,
  `${BASE}/data/schedule.json`,
  `${BASE}/data/schedule_seen.json`,
  `${BASE}/data/summary_state.json`,
  `${BASE}/data/qzone.json`,
  `${BASE}/data/friendreq.json`,
  `${BASE}/data/feed.jsonl`
];

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: 'ignore', windowsHide: true });
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function backup(tag = '') {
  fs.mkdirSync(DEST, { recursive: true });
  const name = `yuzi-${stamp()}${tag ? '-' + tag.replace(/[^\w-]/g, '') : ''}.tgz`;
  const out = path.join(DEST, name);
  const exist = INCLUDE.filter((p) => fs.existsSync(path.join(PARENT, p)));
  const args = ['-czf', out, '-C', PARENT, ...exist];
  const ok = await run('tar', args, PARENT);
  if (!ok) return { ok: false, error: 'tar 打包失败' };
  const st = fs.statSync(out);
  return { ok: true, name, size: st.size, files: exist.length, at: Date.now() };
}

export function listBackups() {
  try {
    return fs.readdirSync(DEST)
      .filter((f) => f.endsWith('.tgz'))
      .map((f) => {
        const st = fs.statSync(path.join(DEST, f));
        return { name: f, size: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.at - a.at);
  } catch { return []; }
}

export async function restore(name) {
  if (!/^yuzi-[\w.-]+\.tgz$/.test(name)) return { ok: false, error: '文件名不合法' };
  const file = path.join(DEST, name);
  if (!fs.existsSync(file)) return { ok: false, error: '备份不存在' };
  // 回滚前先做一份当前状态的安全备份
  await backup('pre-restore');
  const ok = await run('tar', ['-xzf', file, '-C', PARENT], PARENT);
  return ok ? { ok: true, msg: `已回滚 ${name}（回滚前状态已另存为 pre-restore 备份）` } : { ok: false, error: '解包失败' };
}

// CLI：node backup.mjs [tag]
if (process.argv[1] && process.argv[1].endsWith('backup.mjs')) {
  const tag = process.argv[2] || 'manual';
  backup(tag).then((r) => {
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  });
}
