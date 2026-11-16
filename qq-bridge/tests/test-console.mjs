// 玉子控制台 · 接口自测（零依赖）
// 用法：node test-console.mjs
const BASE = 'http://127.0.0.1:3210';
let pass = 0, fail = 0;
const fails = [];

function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; fails.push(name + (extra ? '  ' + extra : '')); console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
}

async function get(p) {
  const r = await fetch(BASE + p, { cache: 'no-store' });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j, text: j ? '' : await r.text() };
}

async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

console.log('\n=== 1. 状态 / 进程 ===');
{
  const s = await get('/api/status');
  ok('GET /api/status 200', s.status === 200);
  const svc = s.json?.services || {};
  for (const id of ['napcat', 'bot', 'watch', 'edge', 'dsh', 'qq']) ok(`服务 ${id} 有字段`, id in svc);
  ok('返回内存信息', typeof s.json?.sys?.freeMemMB === 'number');
}

console.log('\n=== 2. 聊天记录 ===');
{
  const h = await get('/api/history?ch=qqall&limit=5');
  ok('GET /api/history 200', h.status === 200);
  ok('有历史记录', (h.json?.total || 0) > 0, `total=${h.json?.total}`);
  ok('条目结构完整', (h.json?.items || []).every((i) => typeof i.t === 'number' && typeof i.who === 'string' && typeof i.text === 'string'));
  ok('频道列表非空', (h.json?.channels || []).length > 0);

  const q = await get('/api/history?q=' + encodeURIComponent('玉子') + '&limit=3');
  ok('关键词搜索可用', q.status === 200 && Array.isArray(q.json?.items));

  const ex = await fetch(BASE + '/api/history/export?limit=10');
  const buf = Buffer.from(await ex.arrayBuffer());
  ok('导出 txt 有内容', ex.status === 200 && buf.length > 10, `${buf.length} 字节`);
  ok('导出带 BOM（Excel 不乱码）', buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, buf.slice(0, 3).toString('hex'));
}

console.log('\n=== 3. 天气 ===');
{
  const w = await get('/api/weather');
  ok('GET /api/weather 200', w.status === 200);
  ok('天气可用', w.json?.ok === true, w.json?.error || '');
  ok('当前温度是数字', typeof w.json?.now?.temp === 'number');
  ok('5 天预报', (w.json?.days || []).length === 5);
}

console.log('\n=== 4. 余额 / 峰谷 ===');
{
  const b = await get('/api/balance');
  ok('GET /api/balance 200', b.status === 200);
  ok('余额可用', b.json?.ok === true, b.json?.error || '');
  ok('总额是数字', typeof b.json?.total === 'number', `${b.json?.total} ${b.json?.currency}`);
  ok('峰谷状态有标签', !!b.json?.peak?.label, b.json?.peak?.label);
  ok('峰谷有倒计时', typeof b.json?.peak?.nextIn === 'number', `${Math.round((b.json?.peak?.nextIn || 0) / 60)} 分钟`);
}

console.log('\n=== 5. 日程增删 ===');
{
  const before = await get('/api/schedule');
  const n0 = (before.json?.items || []).length;
  await post('/api/schedule', { op: 'add', cat: '测试', item: '自测条目（会自动删）', due: '2099-01-01' });
  const mid = await get('/api/schedule');
  ok('添加成功', (mid.json?.items || []).length === n0 + 1);
  const idx = (mid.json?.items || []).findIndex((i) => i.item === '自测条目（会自动删）');
  await post('/api/schedule', { op: 'del', idx });
  const after = await get('/api/schedule');
  ok('删除成功', (after.json?.items || []).length === n0);
}

console.log('\n=== 6. 插件 / 设置 ===');
{
  const p = await get('/api/plugins');
  ok('GET /api/plugins 200', p.status === 200);
  ok('返回版本号', typeof p.json?.version === 'string', p.json?.version);
  ok('插件是数组', Array.isArray(p.json?.plugins));

  const s = await get('/api/settings');
  ok('GET /api/settings 200', s.status === 200);
  const vars = s.json?.vars || [];
  ok('读到 .env 变量', vars.length > 5, `${vars.length} 项`);
  const key = vars.find((v) => v.key === 'DEEPSEEK_API_KEY');
  ok('API key 打码', !!key && key.secret === true && !String(key.masked).includes('1ece42b'));
}

console.log('\n=== 7. 白名单 / 备份 ===');
{
  const f = await get('/api/friends');
  ok('GET /api/friends 200', f.status === 200 && typeof f.json?.list === 'object');
  const b = await get('/api/backups');
  ok('GET /api/backups 200', b.status === 200);
  ok('备份列表是数组', Array.isArray(b.json?.list));
}

console.log('\n=== 8. 日志 / 空间状态 / 调试信息 ===');
{
  const l = await get('/api/logs?name=boot&lines=20');
  ok('日志可读', l.status === 200 && typeof l.json?.text === 'string' && l.json.text.length > 0);
  const q = await get('/api/qzone/state');
  ok('空间监听状态可读', q.status === 200 && typeof q.json?.pollMs === 'number');
  const d = await get('/api/debug/info');
  ok('调试信息 200', d.status === 200);
  ok('能读到登录账号', !!(d.json?.login && d.json.login.user_id), d.json?.login?.nickname);
  ok('好友列表有内容', (d.json?.friends || []).length > 0);
}

console.log('\n=== 9. 异常处理 ===');
{
  const r404 = await fetch(BASE + '/nope');
  ok('未知路径返回 404', r404.status === 404);
  const bad = await post('/api/debug/send', { text: '' });
  ok('空消息被拒绝', bad.status === 400 && bad.json?.ok === false);
  const badSch = await post('/api/schedule', { op: 'del', idx: 9999 });
  ok('越界日程被拒绝', badSch.status === 400);
}

console.log('\n=== 10. 进程详情 / 二维码热刷新 / 防火墙 ===');
{
  const p = await get('/api/procs');
  ok('GET /api/procs 200', p.status === 200 && !!p.json?.groups);
  const g = p.json?.groups || {};
  ok('进程分组齐全（napcat/qq/edge/dsh/bot/watch/console）',
    ['napcat', 'qq', 'edge', 'dsh', 'bot', 'watch', 'console'].every((k) => Array.isArray(g[k])));
  ok('能拿到 bot 的 PID', (g.bot || []).some((x) => x.pid > 0), JSON.stringify(g.bot?.[0] || {}));
  ok('QQ 进程带启动时间', (g.qq || []).every((x) => typeof x.start === 'string'));

  const q = await get('/api/napcat/qr');
  ok('GET /api/napcat/qr 200', q.status === 200);
  // 已登录时 NapCat 会直接回「不需要二维码」，这本身就是正确行为
  ok('二维码接口有明确结论（ok 或已登录）', q.json?.ok === true || q.json?.loggedIn === true, q.json?.msg || '');

  const fw = await get('/api/firewall');
  ok('GET /api/firewall 200', fw.status === 200 && typeof fw.json?.exists === 'boolean');
}

console.log(`\n================ 结果：通过 ${pass} / 失败 ${fail} ================`);
if (fail) { console.log('失败项：'); fails.forEach((f) => console.log(' - ' + f)); process.exit(1); }
console.log('全部通过。');
process.exit(0);
