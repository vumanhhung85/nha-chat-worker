// Thử WebSocket thật trên workerd (wrangler dev): node test/ws.real.mjs [http://localhost:8788]
import assert from 'node:assert/strict';
const API = process.argv[2] || 'http://localhost:8788';
const WS = API.replace(/^http/, 'ws');
const j = async (p, o = {}) => { const r = await fetch(API + p, o); return { s: r.status, d: await r.json().catch(() => null) }; };
const login = async (m, pin) => (await j('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member: m, setup_key: 'nha-setup', new_pin: pin }) })).d.token
  || (await j('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member: m, pin }) })).d.token;
const bo = await login('bo', '1111'), me = await login('me', '2222');
function open(tok) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(WS + '/ws', ['nha.v1', 'tok.' + tok]);
    ws.got = []; ws.onmessage = e => { if (e.data === 'pong') ws.pong = true; else ws.got.push(JSON.parse(e.data)); };
    ws.onopen = () => res(ws); ws.onerror = () => rej(new Error('ws error'));
  });
}
const wait = async (f, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await new Promise(r => setTimeout(r, 30)); } throw new Error('timeout'); };

// token sai bị từ chối
await assert.rejects(open('sai'));
const a = await open(bo), b = await open(me);
assert.equal(a.protocol, 'nha.v1');
await wait(() => a.got.find(x => x.t === 'hello'));
await wait(() => a.got.some(x => x.t === 'presence' && x.online.includes('me')));
// gửi tin → cả hai nhận rev
await j('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bo }, body: JSON.stringify({ conv: 'bo_me', text: 'xin chào' }) });
const ra = await wait(() => a.got.find(x => x.t === 'rev')); const rb = await wait(() => b.got.find(x => x.t === 'rev'));
assert.ok(ra.rev > 0 && rb.rev === ra.rev);
// sync lấy được tin
const sy = await j('/api/sync?rev=0', { headers: { Authorization: 'Bearer ' + me } });
assert.ok(JSON.stringify(sy.d).includes('xin chào'));
// typing
a.send(JSON.stringify({ t: 'typing', conv: 'bo_me' }));
assert.deepEqual(await wait(() => b.got.find(x => x.t === 'typing')), { t: 'typing', conv: 'bo_me', m: 'bo' });
// ping tự động trả pong khi hub ngủ đông
a.send('ping'); await wait(() => a.pong);
// ẩn tab → presence đổi
a.send(JSON.stringify({ t: 'vis', v: 0 }));
await wait(() => b.got.filter(x => x.t === 'presence').pop().online.join() === 'me');
// đóng → presence cập nhật
b.close(); a.close();
// giới hạn 4 socket/người: mở 6 → chỉ còn tối đa 4 mở
const many = []; for (let i = 0; i < 6; i++) many.push(await open(bo));
await wait(() => many.filter(w => w.readyState === 1).length <= 4);
assert.equal(many[5].readyState, 1);
many.forEach(w => w.close());
console.log('✅ WebSocket thật trên workerd đạt');
process.exit(0);
