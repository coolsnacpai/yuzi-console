/**
 * QQ 桥的真实工具层：让 QQ 那头的大肥鱼能在这台电脑上干活、上网。
 * 设计约束：只用 Node 内置能力，不装依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const WORKDIR = process.env.PC_WORKDIR || path.join(HOME, 'Desktop');
const SHELLS = [
  'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
];

const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

function pickShell() {
  for (const s of SHELLS) if (fs.existsSync(s)) return s;
  return 'powershell.exe';
}

function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

/** 跑命令：输出重定向到临时文件（沙箱下管道 spawn 会被 EPERM 挡掉） */
const DANGER = [
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\bRestart-Computer\b/i,
  /\bStop-Computer\b/i,
  /Remove-Item[^\n]*-Recurse[^\n]*\s[A-Za-z]:\s*$/i,
  /rd\s+\/s\s+\/q\s+[A-Za-z]:\\?\s*$/i,
  /del\s+\/[sf]\s+\/q\s+[A-Za-z]:\\?\*/i,
];

export function runShell(cmd, timeoutMs = 120000) {
  if (DANGER.some((re) => re.test(cmd))) {
    return Promise.resolve({ ok: false, out: '这条命令动静太大（格式化/关机/递归删盘），我拒绝执行。要真干请主人手动来。' });
  }
  log(`[shell] ${cmd.slice(0, 120)}`);
  return new Promise((resolve) => {
    const shell = pickShell();
    const tmp = path.join(os.tmpdir(), `qqsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    const script =
      `$ErrorActionPreference='Continue';` +
      `try { & { ${cmd} } 2>&1 | Out-File -FilePath '${tmp}' -Encoding utf8; $ec=$LASTEXITCODE }` +
      ` catch { ($_ | Out-String) | Out-File -Append -FilePath '${tmp}' -Encoding utf8; $ec=1 };` +
      `if ($null -eq $ec) { $ec = 0 }; Add-Content -Path '${tmp}' -Value "" -Encoding utf8;` +
      `Add-Content -Path '${tmp}' -Value "[exit=$ec]" -Encoding utf8`;

    const p = spawn(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: WORKDIR,
      stdio: 'ignore',
      windowsHide: true,
    });

    const timer = setTimeout(() => { try { p.kill(); } catch {} }, timeoutMs);

    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: `无法启动 shell：${e.message}` }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      let out = '';
      try { out = fs.readFileSync(tmp, 'utf8'); } catch { out = ''; }
      try { fs.unlinkSync(tmp); } catch {}
      if (code === 124 || code === null) out += '\n[命令被超时终止]';
      resolve({ ok: code === 0, out: out.trim() || '(没有输出)' });
    });
  });
}

/* ---------------- 文件 ---------------- */

function resolvePath(p) {
  if (!p) return WORKDIR;
  let abs = p;
  if (abs.startsWith('~')) abs = path.join(HOME, abs.slice(1));
  if (!path.isAbsolute(abs)) abs = path.join(WORKDIR, abs);
  return path.normalize(abs);
}

export function listDir(p) {
  const abs = resolvePath(p);
  const items = fs.readdirSync(abs, { withFileTypes: true });
  const lines = items.slice(0, 200).map((d) => {
    if (d.isDirectory()) return `[目录] ${d.name}`;
    let size = '';
    try { size = fmtSize(fs.statSync(path.join(abs, d.name)).size); } catch {}
    return `[文件] ${d.name}  ${size}`;
  });
  return `${abs}\n${lines.join('\n') || '(空目录)'}${items.length > 200 ? `\n…共 ${items.length} 项` : ''}`;
}

export function readFileTool(p, maxChars = 20000) {
  const abs = resolvePath(p);
  const st = fs.statSync(abs);
  if (st.isDirectory()) return listDir(abs);
  if (st.size > 2 * 1048576) return `文件太大（${fmtSize(st.size)}），用 shell 命令处理，比如 Get-Content -Tail 100。`;
  const text = fs.readFileSync(abs, 'utf8');
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(截断，原长 ${text.length} 字符)` : text;
}

export function writeFileTool(p, content) {
  const abs = resolvePath(p);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content ?? '', 'utf8');
  return `已写入 ${abs}（${fmtSize(Buffer.byteLength(content ?? '', 'utf8'))}）`;
}

/** 打包目录为 zip，返回 zip 路径 */
export async function zipPath(target) {
  const abs = resolvePath(target);
  if (!fs.statSync(abs).isDirectory()) return abs;
  const out = path.join(os.tmpdir(), `${path.basename(abs)}-${Date.now()}.zip`);
  const r = await runShell(`Compress-Archive -Path '${abs}\\*' -DestinationPath '${out}' -Force`, 180000);
  if (!fs.existsSync(out)) throw new Error(`打包失败：${r.out.slice(0, 300)}`);
  return out;
}

/* ---------------- 联网 ---------------- */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
}

export async function webSearch(q, limit = 6) {
  const engines = [
    { name: 'ddg-html', url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDdg },
    { name: 'bing', url: `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`, parse: parseBing },
    { name: 'baidu', url: `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`, parse: parseBaidu },
  ];
  const errors = [];
  for (const e of engines) {
    try {
      const res = await fetch(e.url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) { errors.push(`${e.name}: HTTP ${res.status}`); continue; }
      const html = await res.text();
      const items = e.parse(html).slice(0, limit);
      if (items.length) return `${e.name} 结果：\n` + items.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join('\n');
      errors.push(`${e.name}: 解析到 0 条`);
    } catch (err) {
      errors.push(`${e.name}: ${err.message}`);
    }
  }
  return `搜索失败：${errors.join('；')}`;
}

function parseDdg(html) {
  const out = [];
  const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m;
  while ((m = re.exec(html)) && out.length < 10) {
    let url = decodeEntities(m[1]);
    const u = /uddg=([^&]+)/.exec(url);
    if (u) url = decodeURIComponent(u[1]);
    out.push({ url, title: stripTags(m[2] || ''), snippet: stripTags(m[3] || '') });
  }
  return out;
}

function parseBing(html) {
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a><\/h2>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 10) {
    out.push({ url: decodeEntities(m[1]), title: stripTags(m[2] || ''), snippet: stripTags(m[3] || '').slice(0, 200) });
  }
  return out;
}

function parseBaidu(html) {
  const out = [];
  const re = /<h3[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && out.length < 10) {
    out.push({ url: m[1], title: stripTags(m[2] || ''), snippet: '' });
  }
  return out;
}

export async function webFetch(url, maxChars = 6000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) return `抓取失败：HTTP ${res.status}`;
  const ct = res.headers.get('content-type') || '';
  const body = await res.text();
  if (!/html|text|json|xml/i.test(ct)) return `不可读的内容类型 ${ct}，长度 ${body.length}`;
  const text = stripTags(body);
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(截断)` : text;
}

/* ---------------- 给模型看的工具声明 ---------------- */

export const EXTRA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'pc_shell',
      description: '在这台 Windows 电脑上执行 PowerShell 命令，返回标准输出。用于装包、编译、git、查系统信息、批量改文件等任何命令行工作。工作目录默认是桌面。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 PowerShell 命令' },
          timeoutSec: { type: 'number', description: '超时秒数，默认 120' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_ls',
      description: '列出目录内容（文件大小、子目录）。不传路径就列桌面。',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_read',
      description: '读取一个文本文件的内容。',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_write',
      description: '把文本写入文件（覆盖），目录不存在会自动建。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'qq_send_file',
      description: '把电脑上的文件或整个文件夹（自动打包成 zip）发给主人 QQ。主人说「发给我」时用这个。',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '文件或文件夹路径' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '联网搜索，返回标题、链接和摘要。查资料、查新闻、查文档时先用它。',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '抓取一个网页并返回正文纯文本。',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
];

export { resolvePath, WORKDIR, fmtSize };
