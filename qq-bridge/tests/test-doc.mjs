// test-doc.mjs —— 文档格式（docx / doc / rtf）导入导出自测
// 用法：node test-doc.mjs   （需要控制台在 3210 跑着）
// 特点：跑完会把自己造成的记忆/人设改动还原，不留垃圾。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from './docfmt.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const B = 'http://127.0.0.1:3210';
const TMP = path.join(ROOT, 'data', 'doc-test');
const MEM = path.join(ROOT, 'data', 'brain', 'messages.jsonl');
const PERSONA = path.join(ROOT, 'persona.md');
fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };

const personaOrig = fs.readFileSync(PERSONA, 'utf8');
const memOrig = fs.readFileSync(MEM, 'utf8');

async function getBuf(url, name) {
  const r = await fetch(B + url);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(path.join(TMP, name), buf);
  return { r, buf };
}
const strip = (xml) => xml.replace(/<[^>]+>/g, '');

try {
  // 1) 记忆 → docx / doc / yzm
  const m1 = await getBuf('/api/mem/export?scope=all&fmt=docx', 'mem.docx');
  ok(m1.r.status === 200, '记忆导出 docx HTTP 200', Math.round(m1.buf.length / 1024) + 'KB');
  ok(m1.buf[0] === 0x50 && m1.buf[1] === 0x4b, 'docx 是合法 zip');
  const docxText = strip(readZip(m1.buf)['word/document.xml'].toString('utf8'));
  ok(/玉子|主人/.test(docxText), 'docx 正文可读');
  ok(docxText.split('\n').length > 5 || docxText.length > 500, 'docx 有实质内容', docxText.length + ' 字');

  const m2 = await getBuf('/api/mem/export?scope=all&fmt=doc', 'mem.doc');
  ok(m2.buf.slice(0, 5).toString() === '{\\rtf', 'doc 是 RTF 头');
  ok((m2.r.headers.get('content-type') || '').includes('msword'), 'doc Content-Type 正确');

  const m3 = await getBuf('/api/mem/export?scope=qq&fmt=yzm', 'mem.yzm');
  ok(m3.buf[0] === 0x1f && m3.buf[1] === 0x8b, 'yzm 仍是 gzip 记忆包');

  // 2) 性格 → docx / doc / md / yzp
  const p1 = await getBuf('/api/persona/pack?fmt=docx', 'persona.docx');
  ok(p1.buf[0] === 0x50, '性格 docx 导出');
  ok(strip(readZip(p1.buf)['word/document.xml'].toString('utf8')).includes('人设正文'), '性格 docx 含人设正文');
  const p2 = await getBuf('/api/persona/pack?fmt=doc', 'persona.doc');
  ok(p2.buf.slice(0, 5).toString() === '{\\rtf', '性格 doc 导出');
  const p3 = await getBuf('/api/persona/pack?fmt=md', 'persona-md.txt');
  ok(p3.buf.toString('utf8').includes('# 玉子性格包'), '性格 md 导出');
  const p4 = await getBuf('/api/persona/pack?fmt=yzp', 'persona.yzp');
  ok(p4.buf[0] === 0x1f, '性格 yzp 导出');

  // 3) 文档当记忆导入
  const sizeBefore = fs.statSync(MEM).size;
  const im = await (await fetch(B + '/api/mem/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'mem.docx', mode: 'merge', data: m1.buf.toString('base64') })
  })).json();
  ok(im.ok === true && im.asDoc === true, '文档当记忆导入成功', '切出 ' + im.paras + ' 段');
  ok(im.paras > 50, '文档切段数量合理', im.paras + ' 段');
  ok(fs.statSync(MEM).size > sizeBefore, '记忆文件确实变大');

  // 4) 记忆包导入仍走包模式
  const iy = await (await fetch(B + '/api/mem/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'mem.yzm', mode: 'merge', data: m3.buf.toString('base64') })
  })).json();
  ok(iy.ok === true && !iy.asDoc, '记忆包走包模式（不是文档）', '重复 ' + iy.dup);

  // 5) 性格文档导入
  const ip = await (await fetch(B + '/api/persona/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'persona.doc', data: p2.buf.toString('base64') })
  })).json();
  ok(ip.ok === true, '性格 doc 导入成功', '人设 ' + ip.personaLen + ' 字');
  ok(/玉子/.test(fs.readFileSync(PERSONA, 'utf8')), '导入后人设里有「玉子」');
} finally {
  // 还原
  fs.writeFileSync(PERSONA, personaOrig, 'utf8');
  fs.writeFileSync(MEM, memOrig, 'utf8');   // 记忆库整份回滚，保证不留测试数据
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} 通过 / ${fail} 失败（已还原记忆与人设）`);
  process.exitCode = fail ? 1 : 0;
}
