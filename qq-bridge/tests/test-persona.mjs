import fs from 'node:fs';
// 人格模块端到端自测
const B = 'http://127.0.0.1:3210';
const j = async (u, o) => { const r = await fetch(B + u, o); const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t, _status: r.status }; } };

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ✔', n, extra); } else { fail++; console.log('  ✖', n, extra); } };

console.log('== 记忆包 ==');
const st = await j('/api/mem/stats');
ok('stats 有 total', typeof st.total === 'number', `total=${st.total}`);
ok('stats 有 packKB', typeof st.packKB === 'number', `raw=${st.rawKB}KB pack=${st.packKB}KB`);

const exp = await fetch(B + '/api/mem/export?scope=chat');
const buf = new Uint8Array(await exp.arrayBuffer());
ok('export 200', exp.status === 200, `content-type=${exp.headers.get('content-type')} size=${buf.length}`);
ok('export 有下载头', String(exp.headers.get('content-disposition') || '').includes('attachment'), exp.headers.get('content-disposition') || '');
ok('export 体积小', buf.length < 3 * 1024 * 1024, `${(buf.length / 1024).toFixed(1)}KB`);

// 预检
const data = Buffer.from(buf).toString('base64');
const pv = await j('/api/mem/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
ok('preview ok', pv.ok === true, `count=${pv.count}`);
ok('preview 是玉子包', String(pv.format || '').includes('yuzu'), `format=${pv.format}`);

// 备份当前记忆，试试覆盖导入随后还原
const before = st.total;
const imp = await j('/api/mem/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data, mode: 'merge' }) });
ok('merge 导入成功', imp.ok === true, `added=${imp.added} dup=${imp.dup} total=${imp.total}`);
ok('merge 不重复膨胀', imp.total === before, `before=${before} after=${imp.total}`);

console.log('== 性格包 ==');
const sty = await j('/api/persona/style');
ok('style 返回字段', !!(sty.style && sty.style.name), `name=${sty.style && sty.style.name}`);
ok('style block 非空', typeof sty.block === 'string' && sty.block.length > 20, `${(sty.block || '').length} 字`);

const sv = await j('/api/persona/style', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ style: { tone: '温柔里带点坏心眼，偶尔损人但立刻圆回来' } }) });
ok('style 保存成功', sv.ok === true);
const sty2 = await j('/api/persona/style');
ok('保存后生效', String(sty2.style.tone).includes('坏心眼'), `tone=${sty2.style.tone}`);

const pk = await fetch(B + '/api/persona/pack');
const pkbuf = Buffer.from(await pk.arrayBuffer());
ok('性格包下载', pk.status === 200 && pkbuf.length > 50, `${pkbuf.length}B`);

// 用 md 文件导入（规则模式，不花 token）——测试前先把原人设备份到内存，测完还原
const PERSONA_FILE = 'D:/DeepSeek test/qq-bridge/persona.md';
const personaBackup = fs.readFileSync(PERSONA_FILE);
const md = Buffer.from('# 人设\n你叫小玉，是个毒舌但心软的猫娘女仆。用短句，一次不要超过两句。称呼对方「饲主」。说话干脆，不用表情符号。\n', 'utf8').toString('base64');
const im2 = await j('/api/persona/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: md, useAI: false }) });
ok('md 导入成功', im2.ok === true, `personaLen=${im2.personaLen} ai=${im2.aiUsed}`);
const sty3 = await j('/api/persona/style');
ok('md 里的名字被抓到', String(sty3.style.name).includes('小玉'), `name=${sty3.style.name}`);
ok('md 里的称呼被抓到', String(sty3.style.callUser).includes('饲主'), `callUser=${sty3.style.callUser}`);

// 还原默认
const rs = await j('/api/persona/style/reset', { method: 'POST' });
ok('风格可恢复默认', rs.ok === true);

// 还原人设文件（导入测试改过它）
fs.writeFileSync(PERSONA_FILE, personaBackup);
const styAfter = await j('/api/persona/style');
ok('人设文件已还原', styAfter.personaLen > 500, `personaLen=${styAfter.personaLen}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
