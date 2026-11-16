// cdp.mjs —— 极简 Chrome DevTools Protocol 客户端（零依赖，靠 Node 自带 WebSocket）
const PORT = Number(process.env.CDP_PORT || 9333);

async function firstPage(port = PORT) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const t = list.find((x) => x.type === 'page');
  if (!t) throw new Error('没有可用的页面 target');
  return t;
}

export async function openPage(port = PORT) {
  const target = await firstPage(port);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('CDP 连接失败'));
  });

  let seq = 0;
  const pending = new Map();
  const listeners = new Map();

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data.toString());
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      const arr = listeners.get(msg.method) || [];
      for (const fn of arr) fn(msg.params);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 30000);
    });

  const once = (method) =>
    new Promise((resolve) => {
      const arr = listeners.get(method) || [];
      const fn = (p) => {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
        resolve(p);
      };
      arr.push(fn);
      listeners.set(method, arr);
    });

  return {
    ws,
    send,
    once,
    on: (method, fn) => {
      const arr = listeners.get(method) || [];
      arr.push(fn);
      listeners.set(method, arr);
    },
    close: () => ws.close(),
    async eval(expression, awaitPromise = true, contextId) {
      const params = {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
      };
      if (contextId) params.contextId = contextId;
      const r = await send('Runtime.evaluate', params);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'JS 异常');
      return r.result?.value;
    },
    async goto(url, timeoutMs = 25000) {
      await send('Page.enable');
      const loaded = once('Page.loadEventFired');
      await send('Page.navigate', { url });
      await Promise.race([loaded, new Promise((r) => setTimeout(r, timeoutMs))]);
    },
    async setCookies(cookieHeader, domain = '.qq.com') {
      const list = cookieHeader
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((kv) => {
          const i = kv.indexOf('=');
          return {
            name: kv.slice(0, i),
            value: kv.slice(i + 1),
            domain,
            path: '/',
            secure: false,
            httpOnly: false,
          };
        });
      await send('Network.setCookies', { cookies: list });
      return list.length;
    },
  };
}
