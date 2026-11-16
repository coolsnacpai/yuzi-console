// 真实点击「导出」，看会不会弹出系统另存为对话框（截图取证后 Esc 关掉）
import fs from 'node:fs';

const list = await (await fetch('http://127.0.0.1:9556/json/list')).json();
const page = list.find((x) => x.type === 'page' && x.url.includes('3210'));
if (!page) { console.log('no page'); process.exit(0); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => { ws.onopen = r; });

// 先切到「人格」页
await send('Runtime.evaluate', { expression: `(function(){const b=[...document.querySelectorAll('[data-page]')].find(e=>e.dataset.page==='persona'); if(b) b.click(); return 1;})()`, returnByValue: true });
await new Promise((r) => setTimeout(r, 1500));
await send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)', returnByValue: true });
await new Promise((r) => setTimeout(r, 600));

// 找到记忆卡的「导出」按钮位置
const rect = await send('Runtime.evaluate', {
  expression: `(function(){const btns=[...document.querySelectorAll('button')].filter(b=>b.textContent.trim()==='导出' && b.getBoundingClientRect().width>0 && b.offsetParent!==null); const b=btns[0]; if(!b) return 'none'; b.scrollIntoView({block:'center'}); const r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2});})()`,
  returnByValue: true
});
console.log('button rect:', rect.result.result.value);
const box = JSON.parse(rect.result.result.value);
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
console.log('clicked 导出');
await new Promise((r) => setTimeout(r, 3000));

const msg = await send('Runtime.evaluate', { expression: `document.getElementById('memMsg').textContent`, returnByValue: true });
console.log('memMsg:', msg.result.result.value);
ws.close();
