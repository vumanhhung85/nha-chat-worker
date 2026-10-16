// Kiểm tra Web Push (mã hóa + VAPID) và Hub (WebSocket) bằng code Worker thật
import assert from 'node:assert/strict';
import { webcrypto as wc } from 'node:crypto';
import { makeEnv } from './harness.mjs';
import worker, { Hub, encryptPush } from '../src/index.js';

const BASE = 'https://nha-chat-api.test.workers.dev';
const pending = [];
const ctx = { waitUntil: p => pending.push(p) };
const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => new Uint8Array(Buffer.from(s, 'base64url'));

// ---- Hub giả: dùng class Hub thật với state + socket giả ----
function fakeSocket() {
  const s = { sent: [], att: null, closed: false };
  s.send = x => s.sent.push(JSON.parse(x));
  s.serializeAttachment = a => { s.att = a; };
  s.deserializeAttachment = () => s.att;
  s.close = () => { s.closed = true; };
  return s;
}
const socks = [];
const state = { getWebSockets: () => socks.filter(s => !s.closed), acceptWebSocket: s => socks.push(s), setWebSocketAutoResponse() {} };
const env = makeEnv(null);
const hub = new Hub(state, env);
env.HUB = { idFromName: () => 'x', get: () => ({ fetch: (u, init) => hub.fetch(new Request(u, init)) }) };

async function call(path, { method = 'GET', token, body } = {}) {
  const h = { Origin: 'http://localhost:8080' };
  if (token) h.Authorization = 'Bearer ' + token;
  let b; if (body) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: b }), env, ctx);
  await Promise.all(pending.splice(0));
  return { status: res.status, data: await res.json() };
}
const ok = r => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const login = async (m, pin) => ok(await call('/api/login', { method: 'POST', body: { member: m, setup_key: 'nha-setup', new_pin: pin } })).token;
const bo = await login('bo', '1111'), me = await login('me', '2222'), nhi = await login('linhnhi', '3333');

// ---- Push: giả lập thiết bị của Linh Nhi ----
const ua = await wc.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPub = new Uint8Array(await wc.subtle.exportKey('raw', ua.publicKey));
const authSecret = wc.getRandomValues(new Uint8Array(16));
const sub = { endpoint: 'https://push.test/send/abc', keys: { p256dh: b64u(uaPub), auth: b64u(authSecret) } };

const pushLog = []; let pushStatus = 201;
const prevFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = typeof input === 'string' ? input : input.url;
  if (u.startsWith('https://push.test/')) { pushLog.push({ url: u, headers: init.headers, body: new Uint8Array(init.body) }); return new Response('', { status: pushStatus }); }
  return prevFetch(input, init);
};

// giải mã như trình duyệt (RFC 8291)
async function decryptAsUA(body) {
  const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20]; assert.equal(rs, 4096); assert.equal(idlen, 65);
  const asPub = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  const asKey = await wc.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await wc.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const hk = async (s, ikm, info, n) => new Uint8Array(await wc.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s, info }, await wc.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
  const te = new TextEncoder();
  const info = new Uint8Array([...te.encode('WebPush: info\0'), ...uaPub, ...asPub]);
  const prk = await hk(authSecret, shared, info, 32);
  const cek = await hk(salt, prk, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hk(salt, prk, te.encode('Content-Encoding: nonce\0'), 12);
  const plain = new Uint8Array(await wc.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await wc.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), ct));
  assert.equal(plain[plain.length - 1], 2);
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

// khóa VAPID công khai ổn định giữa 2 lần gọi
const k1 = ok(await call('/api/push/key', { token: nhi })).key;
assert.equal(ok(await call('/api/push/key', { token: bo })).key, k1);
assert.equal(unb64u(k1).length, 65);
assert.equal((await call('/api/push/key')).status, 401);

assert.equal((await call('/api/push/subscribe', { method: 'POST', token: nhi, body: { endpoint: 'http://x', keys: sub.keys } })).status, 400);
ok(await call('/api/push/subscribe', { method: 'POST', token: nhi, body: sub }));

// Bố nhắn vào nhóm → Linh Nhi nhận push, Mẹ (chưa đăng ký) thì không
ok(await call('/api/send', { method: 'POST', token: bo, body: { conv: 'family', text: 'Con ăn cơm chưa?' } }));
assert.equal(pushLog.length, 1);
let p = pushLog[0];
assert.equal(p.headers['Content-Encoding'], 'aes128gcm');
let payload = await decryptAsUA(p.body);
assert.match(payload.title, /Bố Hưng.*Gia đình/);
assert.equal(payload.body, 'Con ăn cơm chưa?');
assert.equal(payload.conv, 'family');
assert.equal(payload.badge, 1);

// kiểm tra chữ ký VAPID
const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(p.headers.Authorization);
assert.ok(m); assert.equal(m[4], k1);
const vk = await wc.subtle.importKey('raw', unb64u(k1), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
assert.ok(await wc.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vk, unb64u(m[3]), new TextEncoder().encode(m[1] + '.' + m[2])));
const claims = JSON.parse(Buffer.from(m[2], 'base64url'));
assert.equal(claims.aud, 'https://push.test'); assert.match(claims.sub, /^https?:\/\//);
assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 12 * 3600 + 5);

// tin riêng Bố–Mẹ → Linh Nhi không nhận
ok(await call('/api/send', { method: 'POST', token: bo, body: { conv: 'bo_me', text: 'riêng' } }));
assert.equal(pushLog.length, 1);

// Linh Nhi đang mở app (có socket nhìn thấy) → không push
const sNhi = fakeSocket(); state.acceptWebSocket(sNhi); sNhi.serializeAttachment({ m: 'linhnhi', v: 1 });
ok(await call('/api/send', { method: 'POST', token: bo, body: { conv: 'family', text: 'đang mở app' } }));
assert.equal(pushLog.length, 1);
// tab ẩn → lại push
await hub.webSocketMessage(sNhi, JSON.stringify({ t: 'vis', v: 0 }));
ok(await call('/api/send', { method: 'POST', token: bo, body: { conv: 'family', text: 'tab ẩn', hw: { for: 'all' } } }));
assert.equal(pushLog.length, 2);
payload = await decryptAsUA(pushLog[1].body);
assert.match(payload.body, /^📚 Bài tập: tab ẩn/);
assert.equal(payload.badge, 3);

// Bài tập xong → bố mẹ có đăng ký mới nhận push
const uaB = await wc.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const subB = { endpoint: 'https://push.test/send/bo', keys: { p256dh: b64u(new Uint8Array(await wc.subtle.exportKey('raw', uaB.publicKey))), auth: b64u(wc.getRandomValues(new Uint8Array(16))) } };
ok(await call('/api/push/subscribe', { method: 'POST', token: bo, body: subB }));
const hwId = (ok(await call('/api/send', { method: 'POST', token: me, body: { conv: 'family', text: 'Làm bài 3', hw: { for: 'linhnhi' } } }))).message.id;
const before = pushLog.length;
ok(await call('/api/homework/done', { method: 'POST', token: nhi, body: { id: hwId, done: true } }));
const hwPush = pushLog.slice(before).filter(x => x.url.endsWith('/bo'));
assert.equal(hwPush.length, 1);

// Điểm cuối trả 410 → xóa đăng ký
pushStatus = 410;
ok(await call('/api/send', { method: 'POST', token: bo, body: { conv: 'family', text: 'x' } }));
assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE member_id=?').bind('linhnhi').first()).n, 0);
pushStatus = 201;

// hủy đăng ký
ok(await call('/api/push/subscribe', { method: 'POST', token: nhi, body: sub }));
ok(await call('/api/push/unsubscribe', { method: 'POST', token: nhi, body: { endpoint: sub.endpoint } }));
assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE member_id=?').bind('linhnhi').first()).n, 0);

// mã hóa trực tiếp: thử payload lớn
const big = JSON.stringify({ x: 'a'.repeat(3000) });
const enc = await encryptPush({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }, new TextEncoder().encode(big));
assert.equal(JSON.parse(JSON.stringify((await decryptAsUA(enc)))).x.length, 3000);

// ---- Hub ----
socks.length = 0;
const sBo = fakeSocket(), sMe = fakeSocket(), sKid = fakeSocket();
for (const [s, mem] of [[sBo, 'bo'], [sMe, 'me'], [sKid, 'linhnhi']]) { state.acceptWebSocket(s); s.serializeAttachment({ m: mem, v: 1 }); }

// poke sau khi gửi tin → mọi socket nhận rev
[sBo, sMe, sKid].forEach(s => { s.sent.length = 0; });
ok(await call('/api/send', { method: 'POST', token: bo, body: { conv: 'bo_me', text: 'hi' } }));
for (const s of [sBo, sMe, sKid]) { const r = s.sent.filter(x => x.t === 'rev'); assert.ok(r.length >= 1 && r[0].rev > 0); }
// login/upload không poke
[sBo, sMe, sKid].forEach(s => { s.sent.length = 0; });
await login('phuongthao', '4444');
assert.equal(sBo.sent.length, 0);

// typing chỉ tới người cùng cuộc trò chuyện (không tới người gõ)
[sBo, sMe, sKid].forEach(s => { s.sent.length = 0; });
await hub.webSocketMessage(sBo, JSON.stringify({ t: 'typing', conv: 'bo_me' }));
assert.deepEqual(sMe.sent, [{ t: 'typing', conv: 'bo_me', m: 'bo' }]);
assert.equal(sBo.sent.length, 0); assert.equal(sKid.sent.length, 0);
// gõ vào cuộc trò chuyện mình không thuộc → bỏ qua
await hub.webSocketMessage(sKid, JSON.stringify({ t: 'typing', conv: 'bo_me' }));
assert.equal(sMe.sent.length, 1);
// rác
await hub.webSocketMessage(sKid, 'không phải json');

// presence khi ẩn/hiện + khi đóng
[sBo, sMe, sKid].forEach(s => { s.sent.length = 0; });
await hub.webSocketMessage(sKid, JSON.stringify({ t: 'vis', v: 0 }));
assert.deepEqual(sMe.sent.pop(), { t: 'presence', online: ['bo', 'me'] });
sBo.closed = true; await hub.webSocketClose(sBo);
assert.deepEqual(sMe.sent.pop(), { t: 'presence', online: ['me'] });

// giới hạn số socket mỗi người (bản fetch /ws cần workerd → thử bằng wrangler dev)
console.log('✅ Web Push + Hub đều đạt');
