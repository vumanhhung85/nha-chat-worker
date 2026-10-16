// Mock D1 (node:sqlite) + R2 (bộ nhớ) + Telegram API để chạy Worker thật ở máy cục bộ.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function makeD1(schemaPath) {
  const db = new DatabaseSync(':memory:');
  if (schemaPath) db.exec(readFileSync(schemaPath, 'utf8'));
  function stmt(sql, args) {
    return {
      bind: (...a) => stmt(sql, a.map(v => (v === undefined ? (() => { throw new Error('D1_TYPE_ERROR: undefined bind in ' + sql); })() : v))),
      first: async () => { const r = db.prepare(sql).all(...(args || [])); return r[0] || null; },
      all: async () => ({ results: db.prepare(sql).all(...(args || [])), meta: {} }),
      run: async () => { const r = db.prepare(sql).run(...(args || [])); return { meta: { changes: Number(r.changes) } }; },
      _exec: () => ({ results: db.prepare(sql).all(...(args || [])), meta: {} })
    };
  }
  return {
    _db: db,
    prepare: sql => stmt(sql, []),
    batch: async list => {
      db.exec('BEGIN');
      try { const out = list.map(s => s._exec()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    }
  };
}

export function makeR2() {
  const store = new Map();
  return {
    _store: store,
    async put(key, val, opts) {
      let buf;
      if (val instanceof Blob) buf = new Uint8Array(await val.arrayBuffer());
      else if (val instanceof ArrayBuffer) buf = new Uint8Array(val);
      else if (val instanceof Uint8Array) buf = val;
      else buf = new Uint8Array(await new Response(val).arrayBuffer());
      store.set(key, { buf, meta: (opts && opts.httpMetadata) || {} });
    },
    async get(key, opts) {
      const o = store.get(key); if (!o) return null;
      let range = null, body = o.buf;
      if (opts && opts.range) {
        const h = opts.range.get ? opts.range.get('Range') : null;
        const m = /bytes=(\d*)-(\d*)/.exec(h || '');
        if (m) {
          if (m[1] === '') { const s = Number(m[2]); range = { suffix: s }; body = o.buf.slice(o.buf.length - s); }
          else { const a = Number(m[1]); const b = m[2] === '' ? o.buf.length - 1 : Number(m[2]); range = { offset: a, length: b - a + 1 }; body = o.buf.slice(a, b + 1); }
        }
      }
      return {
        body, size: o.buf.length, httpEtag: '"e' + o.buf.length + '"', range,
        writeHttpMetadata: h => { if (o.meta.contentType) h.set('Content-Type', o.meta.contentType); }
      };
    },
    async delete(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(k => store.delete(k)); }
  };
}

// Giả lập Telegram Bot API
export const tgLog = [];
let tgMsgId = 1000;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = typeof input === 'string' ? input : input.url;
  if (u.startsWith('https://api.telegram.org/')) {
    const method = u.split('/').pop();
    const payload = init && init.body ? JSON.parse(init.body) : {};
    tgLog.push({ method, payload });
    if (method === 'getMe') return Response.json({ ok: true, result: { username: 'nhaminh_test_bot' } });
    if (method === 'sendMessage' || method === 'sendPhoto') return Response.json({ ok: true, result: { message_id: ++tgMsgId } });
    return Response.json({ ok: true, result: true });
  }
  return realFetch(input, init);
};

// Mặc định giống production: DB trống (Worker tự tạo bảng), không có SECRET, token Telegram nhập trong app
export function makeEnv(schemaPath, extra) {
  return Object.assign({ DB: makeD1(schemaPath), BUCKET: makeR2(), SETUP_KEY: 'nha-setup', APP_URL: 'http://localhost:8080' }, extra || {});
}
export const ctx = { waitUntil: p => p };
