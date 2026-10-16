// Kiểm tra API bằng code Worker thật + D1/R2/Telegram giả lập
import assert from 'node:assert/strict';
import { makeEnv, tgLog } from './harness.mjs';
import worker from '../src/index.js';

const env = makeEnv(null);   // DB trống → Worker phải tự tạo bảng
const pending = [];
const ctx = { waitUntil: p => pending.push(p) };
const BASE = 'https://nha-chat-api.test.workers.dev';

async function call(path, { method = 'GET', token, body, form, headers = {} } = {}) {
  const h = Object.assign({ Origin: 'http://localhost:8080' }, headers);
  if (token) h.Authorization = 'Bearer ' + token;
  let b;
  if (form) b = form; else if (body) { b = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
  const res = await worker.fetch(new Request(BASE + path, { method, headers: h, body: b }), env, ctx);
  await Promise.all(pending.splice(0));
  const ct = res.headers.get('Content-Type') || '';
  return { status: res.status, res, data: ct.includes('json') ? await res.json() : null };
}
const ok = (r, msg) => { assert.equal(r.status, 200, (msg || '') + ' → ' + JSON.stringify(r.data)); return r.data; };

// 1. Danh sách thành viên + đặt PIN lần đầu bằng mã cài đặt
let r = ok(await call('/api/members'));
assert.equal(r.members.length, 4);
assert.equal(r.members.every(m => !m.has_pin), true);

r = await call('/api/login', { method: 'POST', body: { member: 'bo', setup_key: 'sai', new_pin: '1234' } });
assert.equal(r.status, 401);
const bo = ok(await call('/api/login', { method: 'POST', body: { member: 'bo', setup_key: 'nha-setup', new_pin: '1234', device: 'S23' } })).token;

// Bố đặt PIN cho mẹ và 2 bé
for (const [id, pin] of [['me', '2222'], ['linhnhi', '3333'], ['phuongthao', '4444']]) ok(await call('/api/admin/member', { method: 'POST', token: bo, body: { id, pin } }), 'set pin ' + id);
const me_ = ok(await call('/api/login', { method: 'POST', body: { member: 'me', pin: '2222' } })).token;
const ln = ok(await call('/api/login', { method: 'POST', body: { member: 'linhnhi', pin: '3333' } })).token;
const pt = ok(await call('/api/login', { method: 'POST', body: { member: 'phuongthao', pin: '4444' } })).token;

// Sai PIN 5 lần → khóa
for (let i = 0; i < 4; i++) assert.equal((await call('/api/login', { method: 'POST', body: { member: 'phuongthao', pin: '0000' } })).status, 401);
assert.equal((await call('/api/login', { method: 'POST', body: { member: 'phuongthao', pin: '0000' } })).status, 429);
assert.equal((await call('/api/login', { method: 'POST', body: { member: 'phuongthao', pin: '4444' } })).status, 429);
env.DB._db.exec("UPDATE members SET locked_until=0 WHERE id='phuongthao'");

// Bé không vào được quản trị
assert.equal((await call('/api/admin/sessions', { token: ln })).status, 403);

// 2. Bootstrap: Linh Nhi thấy nhóm + 3 cặp riêng
let boot = ok(await call('/api/bootstrap', { token: ln }));
assert.equal(boot.convs.length, 4);
assert.ok(boot.convs.find(c => c.id === 'family'));
assert.ok(!boot.convs.find(c => c.id === 'bo_me'));
assert.equal((await call('/api/messages?conv=bo_me', { token: ln })).status, 403);

// 3. Telegram: bố nhập token trong app → tự cài webhook; bố kết nối
assert.equal((await call('/api/admin/telegram', { method: 'POST', token: bo, body: { token: 'sai' } })).status, 400);
assert.equal((await call('/api/admin/telegram', { method: 'POST', token: ln, body: { token: '123456789:' + 'A'.repeat(35) } })).status, 403);
ok(await call('/api/admin/telegram', { method: 'POST', token: bo, body: { token: '123456789:' + 'A'.repeat(35) } }));
assert.equal(ok(await call('/api/admin/status', { token: bo })).tg_bot, 'nhaminh_test_bot');
assert.ok(env.DB._db.prepare("SELECT v FROM meta WHERE k='secret'").get().v.length === 64, 'SECRET tự sinh');
assert.equal(tgLog.find(x => x.method === 'setWebhook').payload.url, BASE + '/tg/webhook');
const link = ok(await call('/api/tg/link', { method: 'POST', token: bo }));
const code = link.url.split('start=')[1];
const secret = tgLog.find(x => x.method === 'setWebhook').payload.secret_token;
const hook = (upd) => call('/tg/webhook', { method: 'POST', body: upd, headers: { 'X-Telegram-Bot-Api-Secret-Token': secret } });
assert.equal((await call('/tg/webhook', { method: 'POST', body: {}, headers: { 'X-Telegram-Bot-Api-Secret-Token': 'sai' } })).status, 403);
await hook({ message: { message_id: 1, chat: { id: 555111, type: 'private' }, from: { id: 555111 }, text: '/start ' + code } });
assert.equal(env.DB._db.prepare("SELECT tg_chat_id FROM members WHERE id='bo'").get().tg_chat_id, '555111');

// 4. Bố giao bài tập cho Linh Nhi trong nhóm, kèm ảnh
const img = new Blob([new Uint8Array(5000).fill(7)], { type: 'image/jpeg' });
const fd = new FormData(); fd.append('file', img, 'bai5.jpg'); fd.append('name', 'bai5.jpg'); fd.append('kind', 'image'); fd.append('w', '1800'); fd.append('h', '1200');
fd.append('thumb', new Blob([new Uint8Array(500)], { type: 'image/jpeg' }), 't.jpg');
const att = ok(await call('/api/upload', { method: 'POST', token: bo, form: fd }));
assert.equal(att.kind, 'image');
tgLog.length = 0;
let sent = ok(await call('/api/send', { method: 'POST', token: bo, body: { conv: 'family', text: 'Làm bài 5 trang 32 nhé con', atts: [att.id], hw: { for: 'linhnhi', due: '2026-10-07' } } })).message;
assert.equal(sent.hw.for, 'linhnhi');
assert.equal(sent.atts.length, 1);
assert.ok(sent.atts[0].url.startsWith(BASE + '/f/'));
// Bố là người gửi → không tự báo Telegram cho mình
assert.equal(tgLog.filter(x => x.method.startsWith('send')).length, 0);

// Đính kèm đã dùng không được dùng lại; bé không giao bài tập được
assert.equal((await call('/api/send', { method: 'POST', token: bo, body: { conv: 'family', atts: [att.id] } })).status, 400);
assert.equal((await call('/api/send', { method: 'POST', token: ln, body: { conv: 'family', text: 'x', hw: { for: 'phuongthao' } } })).status, 403);

// 5. File ký số + Range
const fileUrl = new URL(sent.atts[0].url);
let fr = await worker.fetch(new Request(fileUrl, { headers: { Range: 'bytes=0-99' } }), env, ctx);
assert.equal(fr.status, 206);
assert.equal(fr.headers.get('Content-Range'), 'bytes 0-99/5000');
fr = await worker.fetch(new Request(fileUrl.href.replace(/s=[0-9a-f]+/, 's=00')), env, ctx);
assert.equal(fr.status, 403);

// 6. Đồng bộ: Linh Nhi nhận tin mới
const rev0 = boot.rev;
let s = ok(await call('/api/sync?rev=' + rev0, { token: ln }));
assert.equal(s.messages.length, 1);
assert.equal(s.convs.find(c => c.id === 'family').unread, 1);
const same = ok(await call('/api/sync?rev=' + s.rev, { token: ln }));
assert.equal(same.same, true);

// Linh Nhi đọc + bấm xong bài → Bố nhận Telegram
ok(await call('/api/read', { method: 'POST', token: ln, body: { conv: 'family', last_id: sent.id } }));
tgLog.length = 0;
let done = ok(await call('/api/homework/done', { method: 'POST', token: ln, body: { id: sent.id, done: true } })).message;
assert.ok(done.hw.done.linhnhi);
assert.equal(tgLog.filter(x => x.method === 'sendMessage').length, 1);
assert.match(tgLog[0].payload.text, /đã làm xong bài tập/);
// Phương Thảo không bấm được bài của chị
assert.equal((await call('/api/homework/done', { method: 'POST', token: pt, body: { id: sent.id, done: true } })).status, 403);
let hwList = ok(await call('/api/homework', { token: pt }));
assert.equal(hwList.messages.length, 0);
hwList = ok(await call('/api/homework', { token: ln }));
assert.equal(hwList.messages.length, 1);

// Bố thấy "đã xem"
boot = ok(await call('/api/bootstrap', { token: bo }));
assert.equal(boot.convs.find(c => c.id === 'family').reads.linhnhi, sent.id);

// 7. Bé gửi tin → Bố nhận Telegram, trả lời từ Telegram vào đúng nhóm
tgLog.length = 0;
const kidMsg = ok(await call('/api/send', { method: 'POST', token: ln, body: { conv: 'bo_linhnhi', text: 'Bố ơi con xong rồi' } })).message;
const notif = tgLog.find(x => x.method === 'sendMessage');
assert.ok(notif, 'phải báo Telegram cho bố');
assert.equal(notif.payload.chat_id, '555111');
const tgMsg = env.DB._db.prepare('SELECT * FROM tg_map WHERE msg_id=?').get(kidMsg.id);
await hook({ message: { message_id: 50, chat: { id: 555111, type: 'private' }, from: { id: 555111 }, text: 'Giỏi quá con!', reply_to_message: { message_id: Number(tgMsg.tg_msg_id) } } });
let msgs = ok(await call('/api/messages?conv=bo_linhnhi', { token: ln })).messages;
assert.equal(msgs.length, 2);
assert.equal(msgs[1].text, 'Giỏi quá con!');
assert.equal(msgs[1].via, 'telegram');
assert.equal(msgs[1].reply.id, kidMsg.id);
// Nút "👍" trên Telegram
await hook({ callback_query: { id: 'cb1', from: { id: 555111 }, message: { chat: { id: 555111 } }, data: 'r:' + kidMsg.id + ':👍' } });
msgs = ok(await call('/api/messages?conv=bo_linhnhi', { token: ln })).messages;
assert.equal(msgs[0].react.bo, '👍');
// Người lạ nhắn bot
await hook({ message: { message_id: 9, chat: { id: 999, type: 'private' }, from: { id: 999 }, text: 'hello' } });
assert.match(tgLog[tgLog.length - 1].payload.text, /chỉ dành cho gia đình/);

// 8. Thu hồi: bé trong 24h được, quá 24h không được; bố ẩn tin bé
ok(await call('/api/recall', { method: 'POST', token: ln, body: { id: kidMsg.id } }));
const old = ok(await call('/api/send', { method: 'POST', token: ln, body: { conv: 'family', text: 'tin cũ' } })).message;
env.DB._db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(Date.now() - 25 * 3600 * 1000, old.id);
assert.equal((await call('/api/recall', { method: 'POST', token: ln, body: { id: old.id } })).status, 403);
assert.equal((await call('/api/recall', { method: 'POST', token: bo, body: { id: old.id } })).status, 403); // không phải tin của bố
ok(await call('/api/hide', { method: 'POST', token: bo, body: { id: old.id, hidden: true } }));
msgs = ok(await call('/api/messages?conv=family', { token: pt })).messages;
const hid = msgs.find(m => m.id === old.id);
assert.equal(hid.text, '');
assert.ok(hid.hidden);
msgs = ok(await call('/api/messages?conv=family', { token: me_ })).messages;
assert.equal(msgs.find(m => m.id === old.id).text, 'tin cũ');

// 9. Ghim (bé không ghim được), cảm xúc, đổi avatar
assert.equal((await call('/api/pin', { method: 'POST', token: ln, body: { id: sent.id, pinned: true } })).status, 403);
ok(await call('/api/pin', { method: 'POST', token: me_, body: { id: sent.id, pinned: true } }));
assert.equal(ok(await call('/api/pinned?conv=family', { token: pt })).messages.length, 1);
ok(await call('/api/react', { method: 'POST', token: pt, body: { id: sent.id, emoji: '❤️' } }));
assert.equal((await call('/api/react', { method: 'POST', token: pt, body: { id: sent.id, emoji: '💩' } })).status, 400);
const prof = ok(await call('/api/me/profile', { method: 'POST', token: pt, body: { avatar: '🐱' } }));
assert.equal(prof.members.find(m => m.id === 'phuongthao').avatar, '🐱');

// 10. Đổi PIN, phiên, đăng xuất
assert.equal((await call('/api/me/pin', { method: 'POST', token: pt, body: { old_pin: '1111', new_pin: '5555' } })).status, 401);
ok(await call('/api/me/pin', { method: 'POST', token: pt, body: { old_pin: '4444', new_pin: '5555' } }));
const ses = ok(await call('/api/admin/sessions', { token: bo })).sessions;
assert.ok(ses.length >= 4);
const ptSes = ses.find(x => x.member === 'phuongthao');
ok(await call('/api/admin/revoke', { method: 'POST', token: bo, body: { id: ptSes.id } }));
assert.equal((await call('/api/bootstrap', { token: pt })).status, 401);
assert.equal((await call('/api/nope', { token: bo })).data.code, 'unknown_action');

// CORS
const pre = await worker.fetch(new Request(BASE + '/api/send', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8080' } }), env, ctx);
assert.equal(pre.status, 204);
assert.equal(pre.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8080');

console.log('✅ Tất cả kiểm tra API đều đạt');
