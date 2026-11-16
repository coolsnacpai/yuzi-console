// docfmt.mjs —— 零依赖的文档格式读写：.docx（真 Word）/ .doc（RTF 兼容）/ .rtf / .md / .txt
// 读：docx（zip+XML）、rtf、Word 97 二进制（启发式抽文本）、HTML 伪 doc、纯文本
// 写：docx（最小合法包）、rtf（Word 可直接打开，保存成 .doc 也可）
import zlib from 'node:zlib';

/* ---------------- CRC32 & ZIP ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 打一个最小 zip（全部 store，不压缩；docx 完全合法） */
export function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const rawData = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(rawData);
    const packed = zlib.deflateRawSync(rawData, { level: 9 });
    const data = packed.length < rawData.length ? packed : rawData;
    const method = data === packed && packed.length < rawData.length ? 8 : 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 flag
    local.writeUInt16LE(method, 8);      // 8 = deflate, 0 = store
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x21, 12);       // date (1998-01-01, 无所谓)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(rawData.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(rawData.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const cdStart = offset;
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/** 解 zip，返回 { 文件名: Buffer } */
export function readZip(buf) {
  const out = {};
  // 找 EOCD
  let eo = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eo = i; break; }
  }
  if (eo < 0) throw new Error('不是有效的 zip/docx（找不到目录尾）');
  const count = buf.readUInt16LE(eo + 10);
  let p = buf.readUInt32LE(eo + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    // 局部头
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + csize);
    try {
      out[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    } catch { out[name] = raw; }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ---------------- docx 写 ---------------- */
function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 生成 docx
 * blocks: [{ text, bold?, size?, align?, color? }] 或纯字符串数组
 */
export function writeDocx(title, blocks) {
  const P = (b) => {
    const o = typeof b === 'string' ? { text: b } : (b || {});
    const text = String(o.text ?? '');
    const sz = o.size ? `<w:sz w:val="${o.size * 2}"/><w:szCs w:val="${o.size * 2}"/>` : '';
    const bold = o.bold ? '<w:b/><w:bCs/>' : '';
    const color = o.color ? `<w:color w:val="${o.color}"/>` : '';
    const jc = o.align ? `<w:jc w:val="${o.align}"/>` : '';
    const runs = text.split('\n').map((line, i) =>
      `<w:r><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:eastAsia="Microsoft YaHei" w:hAnsi="Microsoft YaHei"/>${bold}${sz}${color}</w:rPr>${i ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r>`
    ).join('');
    return `<w:p><w:pPr>${jc}${o.size ? `<w:rPr>${sz}</w:rPr>` : ''}</w:pPr>${runs}</w:p>`;
  };
  const body = [title ? P({ text: title, bold: true, size: 18, align: 'center' }) : '', ...(blocks || []).map(P)].join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  return makeZip([
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: doc },
  ]);
}

/* ---------------- 读：docx ---------------- */
export function readDocxText(buf) {
  const files = readZip(buf);
  const key = Object.keys(files).find((k) => /^word\/document\.xml$/i.test(k)) ||
    Object.keys(files).find((k) => /document\.xml$/i.test(k));
  if (!key) throw new Error('docx 里找不到 word/document.xml');
  let xml = files[key].toString('utf8');
  xml = xml.replace(/<w:tab\s*\/>/g, '\t').replace(/<w:br\s*\/>/g, '\u0001');
  const decode = (s) => s.replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const lines = [];
  for (const para of xml.split(/<\/w:p>/)) {
    const runs = [];
    const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let m;
    while ((m = re.exec(para))) runs.push(decode(m[1]));
    let line = runs.join('').replace(/\u0001/g, '\n');
    if (line.trim()) lines.push(line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------------- 读：RTF（含 .doc 存成 RTF 的情况） ---------------- */
export function readRtfText(str) {
  let s = String(str);
  s = s.replace(/\{\\fonttbl[\s\S]*?\}\s*/g, '').replace(/\{\\colortbl[\s\S]*?\}\s*/g, '')
       .replace(/\{\\stylesheet[\s\S]*?\}\s*/g, '').replace(/\{\\info[\s\S]*?\}\s*/g, '');
  s = s.replace(/\\'([0-9a-fA-F]{2})/g, (_, h) => {
    const b = parseInt(h, 16);
    return b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '';
  });
  s = s.replace(/\\u(-?\d+)\??/g, (_, d) => {
    let code = Number(d);
    if (code < 0) code += 65536;
    return String.fromCharCode(code);
  });
  s = s.replace(/\\par[d]?/g, '\n').replace(/\\line/g, '\n').replace(/\\tab/g, '\t');
  s = s.replace(/\{\\\*[\s\S]*?\}/g, '');            // 目标组
  s = s.replace(/\\[a-zA-Z]+-?\d* ?/g, '');          // 其余控制字
  s = s.replace(/[{}]/g, '');
  s = s.replace(/\\\*/g, '');
  return s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------------- 读：Word 97-2003 二进制（启发式） ---------------- */
export function readDocBinaryText(buf) {
  // 1) 先看是不是伪装成 .doc 的 RTF / HTML / docx
  const head = buf.slice(0, 1024).toString('latin1');
  if (head.includes('{\\rtf')) return readRtfText(buf.toString('latin1'));
  if (/^PK\x03\x04/.test(buf.slice(0, 4).toString('latin1'))) return readDocxText(buf);
  const h = buf.slice(0, 4096).toString('utf8').toLowerCase();
  if (h.includes('<html') || h.includes('<w:worddocument') || h.includes('<body')) {
    return buf.toString('utf8')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }
  // 2) 真 CFB：抽 UTF-16LE 的可见文本段
  const pieces = [];
  let cur = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = buf.readUInt16LE(i);
    const ok = (code >= 0x20 && code <= 0x7e) || (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x303f) || (code >= 0xff00 && code <= 0xff60) ||
      code === 0x0a || code === 0x0d || code === 0x09;
    if (ok) cur.push(code);
    else {
      if (cur.length >= 6) pieces.push(String.fromCharCode(...cur));
      cur = [];
    }
  }
  if (cur.length >= 6) pieces.push(String.fromCharCode(...cur));
  const text = pieces.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 8) {
    throw new Error('这个 .doc 是 Word 97 二进制格式，抽不出可读文本。请在 Word 里「另存为」.docx 或 .txt 再上传。');
  }
  return text;
}

/* ---------------- 读：任意文档（自动嗅探） ---------------- */
export function readAnyDoc(buf, filename = '') {
  const ext = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/);
  const e = ext ? ext[1] : '';
  const magic = buf.slice(0, 4).toString('latin1');
  if (magic === 'PK\x03\x04' || e === 'docx') return readDocxText(buf);
  const head = buf.slice(0, 2048).toString('latin1');
  if (head.includes('{\\rtf') || e === 'rtf') return readRtfText(head.slice(0, 200).includes('\\ansicpg') ? buf.toString('latin1') : buf.toString('utf8'));
  if (e === 'doc' || magic === '\xd0\xcf\x11\xe0') return readDocBinaryText(buf);
  // 纯文本：优先 UTF-8，失败退 GBK
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\ufffd')) return utf8.replace(/\r/g, '').trim();
  return buf.toString('latin1').replace(/\r/g, '').trim();
}

/* ---------------- RTF 写（.doc 兼容格式） ---------------- */
export function writeRtf(title, blocks) {
  const esc = (s) => String(s).split('').map((ch) => {
    const c = ch.codePointAt(0);
    if (ch === '\n') return '\\par\n';
    if (ch === '\\' || ch === '{' || ch === '}') return '\\' + ch;
    if (c < 128) return ch;
    return `\\u${c > 32767 ? c - 65536 : c}?`;
  }).join('');
  const all = [];
  if (title) all.push('{\\fs36\\b ' + esc(title) + '}\\par');
  for (const b of blocks || []) {
    const o = typeof b === 'string' ? { text: b } : (b || {});
    const sz = o.size ? `\\fs${o.size * 2}` : '\\fs22';
    const bold = o.bold ? '\\b' : '';
    all.push(`{${sz}${bold} ${esc(o.text ?? '')}}\\par`);
  }
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil\\fcharset134 Microsoft YaHei;}}\\viewkind4\\uc1\\f0\n${all.join('\n')}\n}`;
}
