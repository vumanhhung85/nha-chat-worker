/**
 * Nhà Mình — Cloudflare Worker (API + file + Telegram webhook)
 *
 * Triển khai: Cloudflare tự build từ GitHub (repo nha-chat-worker) theo wrangler.toml.
 *   - D1 (DB) và R2 (BUCKET) được Cloudflare tự tạo ở lần deploy đầu.
 *   - Bảng dữ liệu được Worker tự tạo ở lần chạy đầu (ensureDb).
 * Secret cần khai báo trong Dashboard (Settings → Variables and Secrets):
 *   SETUP_KEY     : mã cài đặt lần đầu (chỉ Bố biết) — dùng để đặt PIN lần đầu
 * Không bắt buộc:
 *   TG_BOT_TOKEN  : token bot Telegram (hoặc nhập trong app: Cài đặt → Cài đặt hệ thống)
 *   SECRET        : khóa ký link/băm PIN (bỏ trống thì Worker tự sinh và lưu trong D1;
 *                   ĐỪNG thêm/đổi sau khi đã dùng — mọi PIN sẽ phải đặt lại)
 *   APP_URL       : https://nha.tytlinhxuan.cloud (đã khai trong wrangler.toml)
 */

const MAX_FILE = 25 * 1024 * 1024;       // trần cứng 25MB / file
const MAX_TEXT = 4000;
const MAX_ATTS = 10;                      // tối đa 10 tệp / 1 tin
const CHILD_RECALL_MS = 24 * 3600 * 1000; // bé thu hồi trong 24 giờ
const PIN_MAX_FAIL = 5;
const PIN_LOCK_MS = 15 * 60 * 1000;
const SESSION_TOUCH_MS = 10 * 60 * 1000;
const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '👏'];
const DAY = 86400000;

/* Lược đồ D1 — Worker tự tạo bảng ở lần chạy đầu (không cần dán vào Console) */
const SCHEMA = `
-- ============================================================
--  Nhà Mình — schema D1 (database: nha_chat)
--  Dán toàn bộ file này vào D1 → Console → Execute (chạy 1 lần)
-- ============================================================

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
INSERT OR IGNORE INTO meta (k, v) VALUES ('rev', '0');

CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  avatar        TEXT NOT NULL DEFAULT '🙂',
  color         TEXT NOT NULL DEFAULT '#888888',
  role          TEXT NOT NULL CHECK (role IN ('parent','child')),
  sort          INTEGER NOT NULL DEFAULT 0,
  pin_salt      TEXT,
  pin_hash      TEXT,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0,
  tg_chat_id    TEXT,                  -- TEXT: không ép kiểu số
  tg_notify     TEXT NOT NULL DEFAULT 'all' CHECK (tg_notify IN ('all','kids','off')),
  rev           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL,
  device      TEXT,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_member ON sessions(member_id);

CREATE TABLE IF NOT EXISTS conversations (
  id    TEXT PRIMARY KEY,
  type  TEXT NOT NULL CHECK (type IN ('group','direct')),
  name  TEXT
);

CREATE TABLE IF NOT EXISTS conv_members (
  conv_id    TEXT NOT NULL,
  member_id  TEXT NOT NULL,
  PRIMARY KEY (conv_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_cm_member ON conv_members(member_id);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  conv_id      TEXT NOT NULL,
  sender_id    TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  reply_to     INTEGER,
  created_at   INTEGER NOT NULL,
  hw_for       TEXT,                   -- NULL = không phải bài tập; 'all' hoặc id 1 bé
  hw_due       TEXT,                   -- 'YYYY-MM-DD'
  pinned_at    INTEGER,
  pinned_by    TEXT,
  recalled_at  INTEGER,
  hidden_at    INTEGER,
  hidden_by    TEXT,
  via          TEXT NOT NULL DEFAULT 'app',  -- 'app' | 'telegram'
  rev          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conv_id, id);
CREATE INDEX IF NOT EXISTS idx_msg_rev  ON messages(rev);
CREATE INDEX IF NOT EXISTS idx_msg_hw   ON messages(hw_for) WHERE hw_for IS NOT NULL;

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  msg_id      INTEGER,                 -- NULL khi vừa tải lên, chưa gắn vào tin
  uploader    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('image','video','voice','file')),
  r2_key      TEXT NOT NULL,
  thumb_key   TEXT,
  name        TEXT,
  mime        TEXT,
  size        INTEGER,
  w           INTEGER,
  h           INTEGER,
  dur         INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_att_msg ON attachments(msg_id);

CREATE TABLE IF NOT EXISTS reactions (
  msg_id     INTEGER NOT NULL,
  member_id  TEXT NOT NULL,
  emoji      TEXT NOT NULL,
  PRIMARY KEY (msg_id, member_id)
);

CREATE TABLE IF NOT EXISTS hw_done (
  msg_id     INTEGER NOT NULL,
  member_id  TEXT NOT NULL,
  done_at    INTEGER NOT NULL,
  PRIMARY KEY (msg_id, member_id)
);

CREATE TABLE IF NOT EXISTS reads (
  member_id     TEXT NOT NULL,
  conv_id       TEXT NOT NULL,
  last_read_id  INTEGER NOT NULL DEFAULT 0,
  rev           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (member_id, conv_id)
);
CREATE INDEX IF NOT EXISTS idx_reads_rev ON reads(rev);

CREATE TABLE IF NOT EXISTS tg_links (
  code       TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL,
  expires    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tg_map (
  chat_id     TEXT NOT NULL,
  tg_msg_id   TEXT NOT NULL,
  conv_id     TEXT NOT NULL,
  msg_id      INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (chat_id, tg_msg_id)
);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint    TEXT PRIMARY KEY,
  member_id   TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  ua          TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_member ON push_subs(member_id);

-- ---------- Dữ liệu ban đầu: 4 thành viên ----------
INSERT OR IGNORE INTO members (id, name, avatar, color, role, sort) VALUES
  ('bo',          'Bố Hưng',     '👨', '#2F6FDE', 'parent', 1),
  ('me',          'Mẹ Thùy',     '👩', '#E8457C', 'parent', 2),
  ('linhnhi',     'Linh Nhi',    '🦄', '#F5A623', 'child',  3),
  ('phuongthao',  'Phương Thảo', '🐰', '#22B573', 'child',  4);

-- ---------- Nhóm gia đình + 6 cặp chat riêng ----------
INSERT OR IGNORE INTO conversations (id, type, name) VALUES
  ('family',                 'group',  'Gia đình'),
  ('bo_me',                  'direct', NULL),
  ('bo_linhnhi',             'direct', NULL),
  ('bo_phuongthao',          'direct', NULL),
  ('linhnhi_me',             'direct', NULL),
  ('me_phuongthao',          'direct', NULL),
  ('linhnhi_phuongthao',     'direct', NULL);

INSERT OR IGNORE INTO conv_members (conv_id, member_id) VALUES
  ('family','bo'), ('family','me'), ('family','linhnhi'), ('family','phuongthao'),
  ('bo_me','bo'), ('bo_me','me'),
  ('bo_linhnhi','bo'), ('bo_linhnhi','linhnhi'),
  ('bo_phuongthao','bo'), ('bo_phuongthao','phuongthao'),
  ('linhnhi_me','linhnhi'), ('linhnhi_me','me'),
  ('me_phuongthao','me'), ('me_phuongthao','phuongthao'),
  ('linhnhi_phuongthao','linhnhi'), ('linhnhi_phuongthao','phuongthao');
`;
const SCHEMA_V = '2';
let _dbReady = false;
async function ensureDb(env) {
  if (_dbReady) return;
  try {
    const r = await env.DB.prepare("SELECT v FROM meta WHERE k='schema_v'").first();
    if (r && r.v === SCHEMA_V) { _dbReady = true; return; }
  } catch (e) { /* chưa có bảng */ }
  const stmts = SCHEMA.split(/;\s*\n/).map(x => x.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);
  await env.DB.batch(stmts.map(x => env.DB.prepare(x)));
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('schema_v', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(SCHEMA_V).run();
  _dbReady = true;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      await ensureDb(env);
      if (url.pathname === '/ws') return await wsConnect(request, env);
      if (url.pathname.startsWith('/f/')) return await serveFile(request, env, url);
      if (url.pathname === '/tg/webhook' && request.method === 'POST') {
        const res = await tgWebhook(request, env, url, ctx);
        runBg(ctx, pokeHub(env));
        return res;
      }
      if (url.pathname === '/' || url.pathname === '/api') return json({ ok: true, app: 'Nhà Mình' }, 200, cors);
      const res = await route(request, env, url, ctx);
      if (request.method === 'POST' && !NO_POKE.has(url.pathname)) runBg(ctx, pokeHub(env));
      return json(res.body, res.status || 200, cors);
    } catch (e) {
      if (e && e.httpStatus) return json({ error: e.message, code: e.code || null, extra: e.extra || null }, e.httpStatus, cors);
      console.log('ERR', e && e.stack || e);
      return json({ error: 'Lỗi máy chủ: ' + (e && e.message || e) }, 500, cors);
    }
  }
};
const NO_POKE = new Set(['/api/login', '/api/logout', '/api/upload', '/api/admin/telegram', '/api/push/subscribe', '/api/push/unsubscribe']);
function runBg(ctx, p) {
  const j = Promise.resolve(p).catch(e => console.log('bg err', e && e.message || e));
  if (ctx && ctx.waitUntil) ctx.waitUntil(j);
  return j;
}

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */
async function route(request, env, url, ctx) {
  const p = url.pathname;
  const m = request.method;

  // ---- công khai ----
  if (p === '/api/members' && m === 'GET') return ok(await publicMembers(env));
  if (p === '/api/login' && m === 'POST') return ok(await login(env, await body(request)));

  // ---- cần đăng nhập ----
  const me = await auth(request, env);
  const origin = url.origin;

  if (p === '/api/logout' && m === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(me._token).run();
    return ok({ ok: true });
  }
  if (p === '/api/bootstrap' && m === 'GET') return ok(await bootstrap(env, me, origin));
  if (p === '/api/sync' && m === 'GET') return ok(await sync(env, me, origin, int(url.searchParams.get('rev'))));
  if (p === '/api/messages' && m === 'GET') return ok(await listMessages(env, me, origin, url.searchParams));
  if (p === '/api/pinned' && m === 'GET') return ok(await listPinned(env, me, origin, url.searchParams.get('conv')));
  if (p === '/api/homework' && m === 'GET') return ok(await listHomework(env, me, origin));
  if (p === '/api/upload' && m === 'POST') return ok(await upload(request, env, me, origin));
  if (p === '/api/send' && m === 'POST') return ok(await sendFromApp(env, me, origin, await body(request), ctx));
  if (p === '/api/react' && m === 'POST') return ok(await react(env, me, origin, await body(request)));
  if (p === '/api/recall' && m === 'POST') return ok(await recall(env, me, origin, await body(request), ctx));
  if (p === '/api/hide' && m === 'POST') return ok(await hide(env, me, origin, await body(request)));
  if (p === '/api/pin' && m === 'POST') return ok(await pin(env, me, origin, await body(request)));
  if (p === '/api/homework/set' && m === 'POST') return ok(await hwSet(env, me, origin, await body(request)));
  if (p === '/api/homework/done' && m === 'POST') return ok(await hwDone(env, me, origin, await body(request), ctx));
  if (p === '/api/read' && m === 'POST') return ok(await markRead(env, me, await body(request)));
  if (p === '/api/me/pin' && m === 'POST') return ok(await changeMyPin(env, me, await body(request)));
  if (p === '/api/me/profile' && m === 'POST') return ok(await updateMyProfile(env, me, await body(request)));

  if (p === '/api/push/key' && m === 'GET') return ok({ key: (await getVapid(env)).pub });
  if (p === '/api/push/subscribe' && m === 'POST') return ok(await pushSubscribe(env, me, await body(request), request));
  if (p === '/api/push/unsubscribe' && m === 'POST') return ok(await pushUnsubscribe(env, me, await body(request)));

  if (p === '/api/tg/link' && m === 'POST') return ok(await tgLink(env, me));
  if (p === '/api/tg/notify' && m === 'POST') return ok(await tgSetNotify(env, me, await body(request)));
  if (p === '/api/tg/unlink' && m === 'POST') return ok(await tgUnlink(env, me));

  // ---- chỉ bố mẹ ----
  if (p.startsWith('/api/admin/') || p === '/api/tg/setup') {
    if (me.role !== 'parent') throw httpErr(403, 'Chỉ bố mẹ mới dùng được chức năng này');
    if (p === '/api/admin/sessions' && m === 'GET') return ok(await adminSessions(env, me));
    if (p === '/api/admin/revoke' && m === 'POST') return ok(await adminRevoke(env, await body(request)));
    if (p === '/api/admin/member' && m === 'POST') return ok(await adminMember(env, await body(request)));
    if (p === '/api/tg/setup' && m === 'POST') return ok(await tgSetup(env, origin));
    if (p === '/api/admin/telegram' && m === 'POST') return ok(await tgSaveToken(env, origin, await body(request)));
    if (p === '/api/admin/status' && m === 'GET') return ok(await adminStatus(env));
  }
  throw httpErr(404, 'Không có chức năng này: ' + m + ' ' + p, 'unknown_action');
}

/* ------------------------------------------------------------------ */
/*  Tiện ích chung                                                     */
/* ------------------------------------------------------------------ */
function ok(b) { return { status: 200, body: b }; }
function httpErr(status, msg, code, extra) { const e = new Error(msg); e.httpStatus = status; e.code = code; e.extra = extra; return e; }
function int(v, d) { const n = parseInt(v, 10); return isNaN(n) ? (d || 0) : n; }
async function body(request) { try { return await request.json(); } catch (e) { return {}; } }
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {})
  });
}
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = [env.APP_URL || 'https://nha.tytlinhxuan.cloud']
    .concat(String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
  const okOrigin = allowed.indexOf(origin) >= 0 || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': okOrigin ? origin : allowed[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function randHex(bytes) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
}
let _hmacKey = null, _hmacSecret = null, _secret = null;
/** Khóa bí mật: dùng biến SECRET nếu có, không thì tự sinh 1 lần và lưu trong D1 */
async function getSecret(env) {
  if (env.SECRET) return env.SECRET;
  if (_secret) return _secret;
  let r = await env.DB.prepare("SELECT v FROM meta WHERE k='secret'").first();
  if (!r) {
    await env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('secret', ?)").bind(randHex(32)).run();
    r = await env.DB.prepare("SELECT v FROM meta WHERE k='secret'").first();
  }
  _secret = r.v;
  return _secret;
}
async function hmacHex(env, s) {
  const secret = await getSecret(env);
  if (!_hmacKey || _hmacSecret !== secret) {
    _hmacKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    _hmacSecret = secret;
  }
  const sig = await crypto.subtle.sign('HMAC', _hmacKey, new TextEncoder().encode(s));
  return Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
}
function safeEq(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function bumpRev(env) {
  const r = await env.DB.prepare("UPDATE meta SET v = CAST(v AS INTEGER) + 1 WHERE k='rev' RETURNING v").first();
  return Number(r.v);
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

/* ------------------------------------------------------------------ */
/*  Đăng nhập                                                          */
/* ------------------------------------------------------------------ */
async function publicMembers(env) {
  const r = await env.DB.prepare('SELECT id,name,avatar,color,role,sort,(pin_hash IS NOT NULL) AS has_pin FROM members ORDER BY sort').all();
  return { members: r.results.map(x => ({ id: x.id, name: x.name, avatar: x.avatar, color: x.color, role: x.role, has_pin: !!x.has_pin })) };
}
async function pinHash(env, salt, pin) { return hmacHex(env, 'pin|' + salt + '|' + pin); }

async function login(env, b) {
  const id = String(b.member || '');
  const mem = await env.DB.prepare('SELECT * FROM members WHERE id=?').bind(id).first();
  if (!mem) throw httpErr(404, 'Không tìm thấy thành viên');
  const now = Date.now();
  if (mem.locked_until > now) {
    throw httpErr(429, 'Nhập sai nhiều lần. Thử lại sau ' + Math.ceil((mem.locked_until - now) / 60000) + ' phút.', 'locked');
  }
  let good = false;
  if (!mem.pin_hash) {
    // Chưa có PIN: cần mã cài đặt (SETUP_KEY) để đặt PIN lần đầu
    if (!/^\d{4}$/.test(String(b.new_pin || ''))) throw httpErr(400, 'Cần đặt PIN 4 số', 'need_setup');
    good = !!env.SETUP_KEY && safeEq(String(b.setup_key || '').trim(), env.SETUP_KEY);
    if (good) {
      const salt = randHex(8);
      await env.DB.prepare('UPDATE members SET pin_salt=?, pin_hash=?, fail_count=0, locked_until=0 WHERE id=?')
        .bind(salt, await pinHash(env, salt, String(b.new_pin)), id).run();
    }
  } else {
    good = safeEq(await pinHash(env, mem.pin_salt, String(b.pin || '')), mem.pin_hash);
  }
  if (!good) {
    const fails = mem.fail_count + 1;
    if (fails >= PIN_MAX_FAIL) {
      await env.DB.prepare('UPDATE members SET fail_count=0, locked_until=? WHERE id=?').bind(now + PIN_LOCK_MS, id).run();
      throw httpErr(429, 'Sai ' + PIN_MAX_FAIL + ' lần. Tạm khóa 15 phút.', 'locked');
    }
    await env.DB.prepare('UPDATE members SET fail_count=? WHERE id=?').bind(fails, id).run();
    throw httpErr(401, mem.pin_hash ? 'Sai mã PIN. Còn ' + (PIN_MAX_FAIL - fails) + ' lần thử.' : 'Sai mã cài đặt. Còn ' + (PIN_MAX_FAIL - fails) + ' lần thử.', 'bad_pin');
  }
  await env.DB.prepare('UPDATE members SET fail_count=0, locked_until=0 WHERE id=?').bind(id).run();
  const token = randHex(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, member_id, device, created_at, last_seen) VALUES (?,?,?,?,?)')
    .bind(await sha256Hex(token), id, clip(b.device || '', 80), now, now).run();
  return { token, member: id };
}

async function auth(request, env) {
  const h = request.headers.get('Authorization') || '';
  return authToken(env, h.startsWith('Bearer ') ? h.slice(7).trim() : '');
}
async function authToken(env, token) {
  if (!token) throw httpErr(401, 'Chưa đăng nhập', 'no_auth');
  const th = await sha256Hex(token);
  const row = await env.DB.prepare('SELECT s.last_seen, m.* FROM sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=?').bind(th).first();
  if (!row) throw httpErr(401, 'Phiên đăng nhập đã hết, vui lòng đăng nhập lại', 'no_auth');
  const now = Date.now();
  if (now - row.last_seen > SESSION_TOUCH_MS) {
    await env.DB.prepare('UPDATE sessions SET last_seen=? WHERE token_hash=?').bind(now, th).run();
  }
  row._token = th;
  return row;
}

/* ------------------------------------------------------------------ */
/*  Đọc dữ liệu                                                        */
/* ------------------------------------------------------------------ */
async function myConvIds(env, me) {
  const r = await env.DB.prepare('SELECT conv_id FROM conv_members WHERE member_id=?').bind(me.id).all();
  return r.results.map(x => x.conv_id);
}
async function assertMember(env, me, convId) {
  const r = await env.DB.prepare('SELECT 1 AS x FROM conv_members WHERE conv_id=? AND member_id=?').bind(String(convId || ''), me.id).first();
  if (!r) throw httpErr(403, 'Bạn không ở trong cuộc trò chuyện này');
}
async function getMsg(env, me, id) {
  const m = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(int(id)).first();
  if (!m) throw httpErr(404, 'Không tìm thấy tin nhắn');
  await assertMember(env, me, m.conv_id);
  return m;
}

function fileExp() { return (Math.floor(Date.now() / DAY) + 8) * DAY; } // link file sống ~7-8 ngày, ổn định trong ngày
async function signedUrl(env, origin, key, name) {
  const e = fileExp();
  const s = (await hmacHex(env, 'f|' + key + '|' + e)).slice(0, 32);
  return origin + '/f/' + key + '?e=' + e + '&s=' + s + (name ? '&n=' + encodeURIComponent(name) : '');
}

async function serializeMessages(env, rows, viewer, origin) {
  if (!rows.length) return [];
  const ids = JSON.stringify(rows.map(r => r.id));
  const [atts, reacts, dones] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM attachments WHERE msg_id IN (SELECT value FROM json_each(?)) ORDER BY id').bind(ids),
    env.DB.prepare('SELECT * FROM reactions WHERE msg_id IN (SELECT value FROM json_each(?))').bind(ids),
    env.DB.prepare('SELECT * FROM hw_done WHERE msg_id IN (SELECT value FROM json_each(?))').bind(ids)
  ]);
  const replyIds = rows.map(r => r.reply_to).filter(Boolean);
  let replies = {};
  if (replyIds.length) {
    const rr = await env.DB.prepare(
      "SELECT m.id, m.sender_id, m.body, m.recalled_at, m.hidden_at, (SELECT a.kind FROM attachments a WHERE a.msg_id=m.id ORDER BY a.id LIMIT 1) AS kind " +
      'FROM messages m WHERE m.id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(replyIds)).all();
    rr.results.forEach(x => { replies[x.id] = x; });
  }
  const byMsg = {};
  for (const a of atts.results) (byMsg[a.msg_id] = byMsg[a.msg_id] || []).push(a);
  const rx = {}; reacts.results.forEach(r => { (rx[r.msg_id] = rx[r.msg_id] || {})[r.member_id] = r.emoji; });
  const dn = {}; dones.results.forEach(d => { (dn[d.msg_id] = dn[d.msg_id] || {})[d.member_id] = d.done_at; });

  const out = [];
  for (const m of rows) {
    const recalled = !!m.recalled_at;
    const hiddenForMe = !!m.hidden_at && viewer.role !== 'parent';
    const showContent = !recalled && !hiddenForMe;
    const o = {
      id: m.id, conv: m.conv_id, from: m.sender_id, at: m.created_at, rev: m.rev, via: m.via,
      text: showContent ? m.body : '',
      recalled, hidden: m.hidden_at ? { by: m.hidden_by, at: m.hidden_at } : null,
      atts: [], reply: null,
      react: rx[m.id] || {},
      hw: m.hw_for ? { for: m.hw_for, due: m.hw_due || null, done: dn[m.id] || {} } : null,
      pin: m.pinned_at ? { by: m.pinned_by, at: m.pinned_at } : null
    };
    if (showContent) {
      for (const a of (byMsg[m.id] || [])) {
        o.atts.push({
          id: a.id, kind: a.kind, name: a.name, mime: a.mime, size: a.size, w: a.w, h: a.h, dur: a.dur,
          url: await signedUrl(env, origin, a.r2_key, a.name),
          thumb: a.thumb_key ? await signedUrl(env, origin, a.thumb_key) : null
        });
      }
    }
    if (m.reply_to && replies[m.reply_to]) {
      const r = replies[m.reply_to];
      const gone = !!r.recalled_at || (!!r.hidden_at && viewer.role !== 'parent');
      o.reply = { id: r.id, from: r.sender_id, text: gone ? '' : clip(r.body, 140), kind: gone ? null : r.kind, gone };
    }
    out.push(o);
  }
  return out;
}

async function convSummaries(env, me, origin) {
  const convs = await env.DB.prepare(
    'SELECT c.id, c.type, c.name, COALESCE(r.last_read_id,0) AS my_read, ' +
    ' (SELECT MAX(id) FROM messages WHERE conv_id=c.id) AS last_id, ' +
    ' (SELECT COUNT(*) FROM messages m WHERE m.conv_id=c.id AND m.id > COALESCE(r.last_read_id,0) AND m.sender_id != ?1 AND m.recalled_at IS NULL) AS unread, ' +
    ' (SELECT COUNT(*) FROM messages m WHERE m.conv_id=c.id AND m.pinned_at IS NOT NULL AND m.recalled_at IS NULL) AS pins ' +
    'FROM conv_members cm JOIN conversations c ON c.id=cm.conv_id ' +
    'LEFT JOIN reads r ON r.conv_id=c.id AND r.member_id=?1 WHERE cm.member_id=?1').bind(me.id).all();
  const ids = JSON.stringify(convs.results.map(c => c.id));
  const [cm, reads] = await env.DB.batch([
    env.DB.prepare('SELECT conv_id, member_id FROM conv_members WHERE conv_id IN (SELECT value FROM json_each(?))').bind(ids),
    env.DB.prepare('SELECT member_id, conv_id, last_read_id FROM reads WHERE conv_id IN (SELECT value FROM json_each(?))').bind(ids)
  ]);
  const lastIds = convs.results.map(c => c.last_id).filter(Boolean);
  let lastMsgs = {};
  if (lastIds.length) {
    const rows = await env.DB.prepare('SELECT * FROM messages WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(lastIds)).all();
    (await serializeMessages(env, rows.results, me, origin)).forEach(m => { lastMsgs[m.conv] = m; });
  }
  const members = {}; cm.results.forEach(x => { (members[x.conv_id] = members[x.conv_id] || []).push(x.member_id); });
  const rd = {}; reads.results.forEach(x => { (rd[x.conv_id] = rd[x.conv_id] || {})[x.member_id] = x.last_read_id; });
  return convs.results.map(c => ({
    id: c.id, type: c.type, name: c.name, members: members[c.id] || [],
    unread: c.unread, pins: c.pins, my_read: c.my_read,
    last: lastMsgs[c.id] || null, reads: rd[c.id] || {}
  }));
}

async function membersFull(env) {
  const r = await env.DB.prepare('SELECT id,name,avatar,color,role,sort,(tg_chat_id IS NOT NULL) AS tg,tg_notify FROM members ORDER BY sort').all();
  return r.results.map(x => ({ id: x.id, name: x.name, avatar: x.avatar, color: x.color, role: x.role, tg: !!x.tg, tg_notify: x.tg_notify }));
}

async function bootstrap(env, me, origin) {
  const rev = Number((await env.DB.prepare("SELECT v FROM meta WHERE k='rev'").first()).v);
  return { me: me.id, rev, members: await membersFull(env), convs: await convSummaries(env, me, origin), now: Date.now() };
}

async function sync(env, me, origin, since) {
  const rev = Number((await env.DB.prepare("SELECT v FROM meta WHERE k='rev'").first()).v);
  if (rev === since) return { rev, same: true };
  const mine = JSON.stringify(await myConvIds(env, me));
  const [msgs, mems] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM messages WHERE rev > ? AND conv_id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT 301').bind(since, mine),
    env.DB.prepare('SELECT 1 AS x FROM members WHERE rev > ? LIMIT 1').bind(since)
  ]);
  if (msgs.results.length > 300) return { rev, reset: true };
  return {
    rev,
    messages: await serializeMessages(env, msgs.results, me, origin),
    convs: await convSummaries(env, me, origin),
    members: mems.results.length ? await membersFull(env) : null
  };
}

async function listMessages(env, me, origin, q) {
  const conv = q.get('conv');
  await assertMember(env, me, conv);
  const before = int(q.get('before'), 0);
  const limit = Math.min(Math.max(int(q.get('limit'), 40), 1), 100);
  const rows = before
    ? await env.DB.prepare('SELECT * FROM messages WHERE conv_id=? AND id<? ORDER BY id DESC LIMIT ?').bind(conv, before, limit + 1).all()
    : await env.DB.prepare('SELECT * FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT ?').bind(conv, limit + 1).all();
  const more = rows.results.length > limit;
  const list = rows.results.slice(0, limit).reverse();
  return { messages: await serializeMessages(env, list, me, origin), more };
}

async function listPinned(env, me, origin, conv) {
  await assertMember(env, me, conv);
  const rows = await env.DB.prepare('SELECT * FROM messages WHERE conv_id=? AND pinned_at IS NOT NULL AND recalled_at IS NULL ORDER BY pinned_at DESC LIMIT 50').bind(conv).all();
  return { messages: await serializeMessages(env, rows.results, me, origin) };
}

async function listHomework(env, me, origin) {
  const mine = JSON.stringify(await myConvIds(env, me));
  const rows = me.role === 'parent'
    ? await env.DB.prepare('SELECT * FROM messages WHERE hw_for IS NOT NULL AND recalled_at IS NULL AND conv_id IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT 200').bind(mine).all()
    : await env.DB.prepare("SELECT * FROM messages WHERE hw_for IS NOT NULL AND recalled_at IS NULL AND hidden_at IS NULL AND (hw_for='all' OR hw_for=?) AND conv_id IN (SELECT value FROM json_each(?)) ORDER BY id DESC LIMIT 200").bind(me.id, mine).all();
  return { messages: await serializeMessages(env, rows.results, me, origin) };
}

/* ------------------------------------------------------------------ */
/*  Tải tệp lên R2                                                     */
/* ------------------------------------------------------------------ */
function extOf(name, mime) {
  const m = /\.([a-z0-9]{1,6})$/i.exec(name || '');
  if (m) return '.' + m[1].toLowerCase();
  const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'audio/mp4': '.m4a', 'audio/wav': '.wav', 'audio/webm': '.webm', 'video/mp4': '.mp4', 'application/pdf': '.pdf' };
  return map[(mime || '').split(';')[0]] || '';
}
async function putFile(env, blob, name, mime) {
  const d = new Date();
  const key = d.getUTCFullYear() + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + randHex(12) + extOf(name, mime);
  await env.BUCKET.put(key, blob, { httpMetadata: { contentType: mime || 'application/octet-stream' } });
  return key;
}
function kindOf(mime, want) {
  mime = (mime || '').toLowerCase();
  if (want === 'voice' && mime.indexOf('audio/') === 0) return 'voice';
  if (mime.indexOf('image/') === 0 && mime.indexOf('svg') < 0) return 'image';
  if (mime.indexOf('video/') === 0) return 'video';
  return 'file';
}
async function upload(request, env, me, origin) {
  const ct = request.headers.get('Content-Type') || '';
  if (ct.indexOf('multipart/form-data') < 0) throw httpErr(400, 'Sai định dạng tải lên');
  const len = int(request.headers.get('Content-Length'), 0);
  if (len > MAX_FILE + 2 * 1024 * 1024) throw httpErr(413, 'Tệp quá lớn (tối đa 25MB)');
  const fd = await request.formData();
  const file = fd.get('file');
  if (!file || typeof file === 'string') throw httpErr(400, 'Thiếu tệp');
  if (file.size > MAX_FILE) throw httpErr(413, 'Tệp quá lớn (tối đa 25MB)');
  if (file.size === 0) throw httpErr(400, 'Tệp rỗng');
  const name = clip(String(fd.get('name') || file.name || 'tep'), 120);
  const mime = String(file.type || fd.get('mime') || 'application/octet-stream');
  const kind = kindOf(mime, String(fd.get('kind') || ''));
  const key = await putFile(env, file, name, mime);
  let thumbKey = null;
  const thumb = fd.get('thumb');
  if (thumb && typeof thumb !== 'string' && thumb.size > 0 && thumb.size < 1024 * 1024 && (kind === 'image' || kind === 'video')) {
    thumbKey = key + '.t.jpg';
    await env.BUCKET.put(thumbKey, thumb, { httpMetadata: { contentType: 'image/jpeg' } });
  }
  const now = Date.now();
  const r = await env.DB.prepare('INSERT INTO attachments (msg_id, uploader, kind, r2_key, thumb_key, name, mime, size, w, h, dur, created_at) VALUES (NULL,?,?,?,?,?,?,?,?,?,?,?) RETURNING id')
    .bind(me.id, kind, key, thumbKey, name, mime, file.size, int(fd.get('w')) || null, int(fd.get('h')) || null, int(fd.get('dur')) || null, now).first();
  return { id: r.id, kind, name, size: file.size };
}

/* ------------------------------------------------------------------ */
/*  Gửi tin                                                            */
/* ------------------------------------------------------------------ */
async function convMembers(env, convId) {
  const r = await env.DB.prepare('SELECT m.id, m.name, m.avatar, m.role, m.tg_chat_id, m.tg_notify FROM conv_members cm JOIN members m ON m.id=cm.member_id WHERE cm.conv_id=? ORDER BY m.sort').bind(convId).all();
  return r.results;
}
async function validHwFor(env, convId, hwFor) {
  if (hwFor === 'all') return 'all';
  const mem = await convMembers(env, convId);
  const kid = mem.find(x => x.id === hwFor && x.role === 'child');
  if (!kid) throw httpErr(400, 'Người nhận bài tập không hợp lệ');
  return kid.id;
}

/** Tạo tin nhắn — dùng chung cho app và Telegram */
async function createMessage(env, sender, origin, o, ctx) {
  const conv = String(o.conv || '');
  const text = String(o.text || '').replace(/\r\n/g, '\n').trim();
  if (text.length > MAX_TEXT) throw httpErr(400, 'Tin nhắn quá dài (tối đa ' + MAX_TEXT + ' ký tự)');
  const attIds = (Array.isArray(o.atts) ? o.atts : []).map(x => int(x)).filter(Boolean).slice(0, MAX_ATTS);
  if (!text && !attIds.length) throw httpErr(400, 'Tin nhắn trống');
  await assertMember(env, sender, conv);

  if (attIds.length) {
    const own = await env.DB.prepare('SELECT COUNT(*) AS n FROM attachments WHERE id IN (SELECT value FROM json_each(?)) AND uploader=? AND msg_id IS NULL').bind(JSON.stringify(attIds), sender.id).first();
    if (own.n !== attIds.length) throw httpErr(400, 'Tệp đính kèm không hợp lệ, hãy gửi lại');
  }
  let replyTo = null;
  if (o.reply_to) {
    const r = await env.DB.prepare('SELECT id FROM messages WHERE id=? AND conv_id=?').bind(int(o.reply_to), conv).first();
    if (r) replyTo = r.id;
  }
  let hwFor = null, hwDue = null;
  if (o.hw && o.hw.for) {
    if (sender.role !== 'parent') throw httpErr(403, 'Chỉ bố mẹ được giao bài tập');
    hwFor = await validHwFor(env, conv, String(o.hw.for));
    hwDue = /^\d{4}-\d{2}-\d{2}$/.test(String(o.hw.due || '')) ? String(o.hw.due) : null;
  }
  const rev = await bumpRev(env);
  const now = Date.now();
  const ins = await env.DB.prepare('INSERT INTO messages (conv_id, sender_id, body, reply_to, created_at, hw_for, hw_due, via, rev) VALUES (?,?,?,?,?,?,?,?,?) RETURNING *')
    .bind(conv, sender.id, text, replyTo, now, hwFor, hwDue, o.via || 'app', rev).first();
  const stmts = [
    env.DB.prepare('INSERT INTO reads (member_id, conv_id, last_read_id, rev) VALUES (?,?,?,?) ON CONFLICT(member_id, conv_id) DO UPDATE SET last_read_id=excluded.last_read_id, rev=excluded.rev')
      .bind(sender.id, conv, ins.id, rev)
  ];
  if (attIds.length) stmts.push(env.DB.prepare('UPDATE attachments SET msg_id=? WHERE id IN (SELECT value FROM json_each(?)) AND uploader=?').bind(ins.id, JSON.stringify(attIds), sender.id));
  await env.DB.batch(stmts);

  const msg = (await serializeMessages(env, [ins], sender, origin))[0];
  const job = Promise.all([
    notifyNewMessage(env, origin, ins, sender).catch(e => console.log('tg notify', e)),
    pushNewMessage(env, ins, sender).catch(e => console.log('push', e && e.message || e))
  ]);
  if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  return msg;
}

async function sendFromApp(env, me, origin, b, ctx) {
  const msg = await createMessage(env, me, origin, { conv: b.conv, text: b.text, atts: b.atts, reply_to: b.reply_to, hw: b.hw, via: 'app' }, ctx);
  return { message: msg };
}

async function touchMsg(env, id) {
  const rev = await bumpRev(env);
  await env.DB.prepare('UPDATE messages SET rev=? WHERE id=?').bind(rev, id).run();
}
async function fresh(env, me, origin, id) {
  const row = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(id).first();
  return { message: (await serializeMessages(env, [row], me, origin))[0] };
}

async function setReaction(env, member, msgId, emoji) {
  if (emoji && REACTIONS.indexOf(emoji) < 0) throw httpErr(400, 'Cảm xúc không hợp lệ');
  if (emoji) await env.DB.prepare('INSERT INTO reactions (msg_id, member_id, emoji) VALUES (?,?,?) ON CONFLICT(msg_id, member_id) DO UPDATE SET emoji=excluded.emoji').bind(msgId, member.id, emoji).run();
  else await env.DB.prepare('DELETE FROM reactions WHERE msg_id=? AND member_id=?').bind(msgId, member.id).run();
  await touchMsg(env, msgId);
}
async function react(env, me, origin, b) {
  const m = await getMsg(env, me, b.id);
  if (m.recalled_at) throw httpErr(400, 'Tin đã thu hồi');
  await setReaction(env, me, m.id, b.emoji || null);
  return fresh(env, me, origin, m.id);
}

async function recall(env, me, origin, b, ctx) {
  const m = await getMsg(env, me, b.id);
  if (m.sender_id !== me.id) throw httpErr(403, 'Chỉ thu hồi được tin của mình');
  if (m.recalled_at) return fresh(env, me, origin, m.id);
  if (me.role !== 'parent' && Date.now() - m.created_at > CHILD_RECALL_MS) throw httpErr(403, 'Chỉ thu hồi được trong vòng 24 giờ');
  await env.DB.prepare('UPDATE messages SET recalled_at=?, pinned_at=NULL, pinned_by=NULL WHERE id=?').bind(Date.now(), m.id).run();
  const atts = await env.DB.prepare('SELECT r2_key, thumb_key FROM attachments WHERE msg_id=?').bind(m.id).all();
  const keys = [];
  atts.results.forEach(a => { keys.push(a.r2_key); if (a.thumb_key) keys.push(a.thumb_key); });
  if (keys.length) {
    const job = env.BUCKET.delete(keys).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
  }
  await touchMsg(env, m.id);
  return fresh(env, me, origin, m.id);
}

async function hide(env, me, origin, b) {
  if (me.role !== 'parent') throw httpErr(403, 'Chỉ bố mẹ được ẩn tin');
  const m = await getMsg(env, me, b.id);
  const author = await env.DB.prepare('SELECT role FROM members WHERE id=?').bind(m.sender_id).first();
  if (!author || author.role !== 'child') throw httpErr(400, 'Chỉ ẩn được tin của các bé');
  if (b.hidden) await env.DB.prepare('UPDATE messages SET hidden_at=?, hidden_by=? WHERE id=?').bind(Date.now(), me.id, m.id).run();
  else await env.DB.prepare('UPDATE messages SET hidden_at=NULL, hidden_by=NULL WHERE id=?').bind(m.id).run();
  await touchMsg(env, m.id);
  return fresh(env, me, origin, m.id);
}

async function pin(env, me, origin, b) {
  if (me.role !== 'parent') throw httpErr(403, 'Chỉ bố mẹ được ghim tin');
  const m = await getMsg(env, me, b.id);
  if (m.recalled_at) throw httpErr(400, 'Tin đã thu hồi');
  if (b.pinned) await env.DB.prepare('UPDATE messages SET pinned_at=?, pinned_by=? WHERE id=?').bind(Date.now(), me.id, m.id).run();
  else await env.DB.prepare('UPDATE messages SET pinned_at=NULL, pinned_by=NULL WHERE id=?').bind(m.id).run();
  await touchMsg(env, m.id);
  return fresh(env, me, origin, m.id);
}

async function hwSet(env, me, origin, b) {
  if (me.role !== 'parent') throw httpErr(403, 'Chỉ bố mẹ được giao bài tập');
  const m = await getMsg(env, me, b.id);
  if (m.recalled_at) throw httpErr(400, 'Tin đã thu hồi');
  if (!b.for) {
    await env.DB.batch([
      env.DB.prepare('UPDATE messages SET hw_for=NULL, hw_due=NULL WHERE id=?').bind(m.id),
      env.DB.prepare('DELETE FROM hw_done WHERE msg_id=?').bind(m.id)
    ]);
  } else {
    const f = await validHwFor(env, m.conv_id, String(b.for));
    const due = /^\d{4}-\d{2}-\d{2}$/.test(String(b.due || '')) ? String(b.due) : null;
    await env.DB.prepare('UPDATE messages SET hw_for=?, hw_due=? WHERE id=?').bind(f, due, m.id).run();
  }
  await touchMsg(env, m.id);
  return fresh(env, me, origin, m.id);
}

async function hwDone(env, me, origin, b, ctx) {
  const m = await getMsg(env, me, b.id);
  if (!m.hw_for || m.recalled_at) throw httpErr(400, 'Tin này không phải bài tập');
  if (me.role !== 'child') throw httpErr(403, 'Chỉ các bé mới bấm "Xong" được');
  if (m.hw_for !== 'all' && m.hw_for !== me.id) throw httpErr(403, 'Bài tập này không phải của con');
  if (b.done) {
    const r = await env.DB.prepare('INSERT OR IGNORE INTO hw_done (msg_id, member_id, done_at) VALUES (?,?,?)').bind(m.id, me.id, Date.now()).run();
    if (r.meta && r.meta.changes) {
      const job = Promise.all([
        notifyHwDone(env, origin, m, me).catch(e => console.log('tg hw', e)),
        pushHwDone(env, m, me).catch(e => console.log('push hw', e && e.message || e))
      ]);
      if (ctx && ctx.waitUntil) ctx.waitUntil(job); else await job;
    }
  } else {
    await env.DB.prepare('DELETE FROM hw_done WHERE msg_id=? AND member_id=?').bind(m.id, me.id).run();
  }
  await touchMsg(env, m.id);
  return fresh(env, me, origin, m.id);
}

async function markRead(env, me, b) {
  const conv = String(b.conv || '');
  await assertMember(env, me, conv);
  const last = int(b.last_id);
  const cur = await env.DB.prepare('SELECT last_read_id FROM reads WHERE member_id=? AND conv_id=?').bind(me.id, conv).first();
  if (cur && cur.last_read_id >= last) return { ok: true };
  const maxId = await env.DB.prepare('SELECT MAX(id) AS x FROM messages WHERE conv_id=?').bind(conv).first();
  const target = Math.min(last, maxId.x || 0);
  if (!target || (cur && cur.last_read_id >= target)) return { ok: true };
  const rev = await bumpRev(env);
  await env.DB.prepare('INSERT INTO reads (member_id, conv_id, last_read_id, rev) VALUES (?,?,?,?) ON CONFLICT(member_id, conv_id) DO UPDATE SET last_read_id=excluded.last_read_id, rev=excluded.rev')
    .bind(me.id, conv, target, rev).run();
  // Đánh dấu tin cuối là "đã đổi" để người gửi thấy "Đã xem" khi đồng bộ
  await env.DB.prepare('UPDATE messages SET rev=? WHERE id=?').bind(rev, target).run();
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/*  Cá nhân & quản trị                                                 */
/* ------------------------------------------------------------------ */
async function changeMyPin(env, me, b) {
  if (!/^\d{4}$/.test(String(b.new_pin || ''))) throw httpErr(400, 'PIN mới phải gồm 4 chữ số');
  if (!safeEq(await pinHash(env, me.pin_salt, String(b.old_pin || '')), me.pin_hash)) throw httpErr(401, 'PIN cũ không đúng');
  const salt = randHex(8);
  await env.DB.prepare('UPDATE members SET pin_salt=?, pin_hash=? WHERE id=?').bind(salt, await pinHash(env, salt, String(b.new_pin)), me.id).run();
  return { ok: true };
}
async function updateMyProfile(env, me, b) {
  const avatar = clip(String(b.avatar || '').trim(), 8);
  if (!avatar) throw httpErr(400, 'Chưa chọn hình đại diện');
  const rev = await bumpRev(env);
  await env.DB.prepare('UPDATE members SET avatar=?, rev=? WHERE id=?').bind(avatar, rev, me.id).run();
  return { members: await membersFull(env) };
}
async function adminSessions(env, me) {
  const r = await env.DB.prepare('SELECT token_hash, member_id, device, created_at, last_seen FROM sessions ORDER BY last_seen DESC').all();
  return { sessions: r.results.map(s => ({ id: s.token_hash.slice(0, 12), member: s.member_id, device: s.device, created_at: s.created_at, last_seen: s.last_seen, current: s.token_hash === me._token })) };
}
async function adminRevoke(env, b) {
  const id = String(b.id || '');
  if (!/^[0-9a-f]{12}$/.test(id)) throw httpErr(400, 'Mã phiên không hợp lệ');
  await env.DB.prepare("DELETE FROM sessions WHERE substr(token_hash,1,12)=?").bind(id).run();
  return { ok: true };
}
async function adminMember(env, b) {
  const mem = await env.DB.prepare('SELECT * FROM members WHERE id=?').bind(String(b.id || '')).first();
  if (!mem) throw httpErr(404, 'Không tìm thấy thành viên');
  const name = b.name != null ? clip(String(b.name).trim(), 30) : mem.name;
  const avatar = b.avatar != null ? clip(String(b.avatar).trim(), 8) : mem.avatar;
  const color = b.color != null && /^#[0-9a-fA-F]{6}$/.test(String(b.color)) ? String(b.color) : mem.color;
  if (!name || !avatar) throw httpErr(400, 'Tên và hình đại diện không được trống');
  const rev = await bumpRev(env);
  const stmts = [env.DB.prepare('UPDATE members SET name=?, avatar=?, color=?, rev=? WHERE id=?').bind(name, avatar, color, rev, mem.id)];
  if (b.pin != null && b.pin !== '') {
    if (!/^\d{4}$/.test(String(b.pin))) throw httpErr(400, 'PIN phải gồm 4 chữ số');
    const salt = randHex(8);
    stmts.push(env.DB.prepare('UPDATE members SET pin_salt=?, pin_hash=?, fail_count=0, locked_until=0 WHERE id=?').bind(salt, await pinHash(env, salt, String(b.pin)), mem.id));
  }
  await env.DB.batch(stmts);
  return { members: await membersFull(env) };
}

/* ------------------------------------------------------------------ */
/*  File (R2) — link có chữ ký, hỗ trợ Range cho âm thanh/video iOS   */
/* ------------------------------------------------------------------ */
async function serveFile(request, env, url) {
  const key = decodeURIComponent(url.pathname.slice(3));
  const e = int(url.searchParams.get('e'));
  const s = url.searchParams.get('s') || '';
  if (!key || !e || e < Date.now()) return new Response('Liên kết đã hết hạn', { status: 403 });
  const expect = (await hmacHex(env, 'f|' + key + '|' + e)).slice(0, 32);
  if (!safeEq(s, expect)) return new Response('Liên kết không hợp lệ', { status: 403 });

  const hasRange = !!request.headers.get('Range');
  const obj = await env.BUCKET.get(key, hasRange ? { range: request.headers } : undefined);
  if (!obj) return new Response('Không tìm thấy tệp', { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('ETag', obj.httpEtag);
  h.set('Accept-Ranges', 'bytes');
  h.set('Cache-Control', 'private, max-age=86400');
  h.set('Access-Control-Allow-Origin', '*');
  const n = url.searchParams.get('n');
  if (url.searchParams.get('dl') === '1') {
    h.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(n || key.split('/').pop()));
  } else if (n) {
    h.set('Content-Disposition', "inline; filename*=UTF-8''" + encodeURIComponent(n));
  }
  if (hasRange && obj.range) {
    let start, len;
    if (obj.range.suffix != null) { len = Math.min(obj.range.suffix, obj.size); start = obj.size - len; }
    else { start = obj.range.offset || 0; len = obj.range.length != null ? obj.range.length : obj.size - start; }
    h.set('Content-Range', 'bytes ' + start + '-' + (start + len - 1) + '/' + obj.size);
    h.set('Content-Length', String(len));
    return new Response(request.method === 'HEAD' ? null : obj.body, { status: 206, headers: h });
  }
  h.set('Content-Length', String(obj.size));
  return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers: h });
}

/* ------------------------------------------------------------------ */
/*  Telegram                                                           */
/* ------------------------------------------------------------------ */
let _tgToken = null;
async function tgToken(env) {
  if (env.TG_BOT_TOKEN) return env.TG_BOT_TOKEN;
  if (_tgToken !== null) return _tgToken;
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k='tg_token'").first();
  _tgToken = r ? r.v : '';
  return _tgToken;
}
async function tg(env, method, payload, tokenOverride) {
  const token = tokenOverride || await tgToken(env);
  if (!token) return { ok: false, description: 'Chưa nhập token bot Telegram' };
  const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  return r.json();
}
async function tgSecret(env) { return (await hmacHex(env, 'tg-webhook')).slice(0, 48); }
function appUrl(env) { return env.APP_URL || 'https://nha.tytlinhxuan.cloud'; }

async function botUsername(env) {
  const row = await env.DB.prepare("SELECT v FROM meta WHERE k='tg_bot'").first();
  if (row && row.v) return row.v;
  const r = await tg(env, 'getMe', {});
  if (!r.ok) throw httpErr(400, 'Không kết nối được bot Telegram: ' + (r.description || ''));
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('tg_bot', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(r.result.username).run();
  return r.result.username;
}

async function tgSetup(env, origin) {
  const me = await tg(env, 'getMe', {});
  if (!me.ok) throw httpErr(400, 'Token bot không đúng: ' + (me.description || ''));
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('tg_bot', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(me.result.username).run();
  const r = await tg(env, 'setWebhook', {
    url: origin + '/tg/webhook', secret_token: await tgSecret(env),
    allowed_updates: ['message', 'callback_query'], drop_pending_updates: true
  });
  if (!r.ok) throw httpErr(400, 'Không cài được webhook: ' + (r.description || ''));
  return { ok: true, bot: me.result.username };
}

async function tgSaveToken(env, origin, b) {
  const token = String(b.token || '').trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw httpErr(400, 'Token không đúng dạng (ví dụ 123456789:ABC...)');
  const me = await tg(env, 'getMe', {}, token);
  if (!me.ok) throw httpErr(400, 'Telegram từ chối token này: ' + (me.description || ''));
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('tg_token', ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(token).run();
  _tgToken = token;
  return tgSetup(env, origin);
}
async function adminStatus(env) {
  const bot = await env.DB.prepare("SELECT v FROM meta WHERE k='tg_bot'").first();
  return { tg_bot: bot ? bot.v : null, tg_token: !!(await tgToken(env)), token_from_env: !!env.TG_BOT_TOKEN };
}

async function tgLink(env, me) {
  if (me.role !== 'parent') throw httpErr(403, 'Telegram chỉ dành cho bố mẹ');
  const user = await botUsername(env);
  const code = randHex(10);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tg_links WHERE expires < ?').bind(Date.now()),
    env.DB.prepare('INSERT INTO tg_links (code, member_id, expires) VALUES (?,?,?)').bind(code, me.id, Date.now() + 30 * 60 * 1000)
  ]);
  return { url: 'https://t.me/' + user + '?start=' + code, bot: user };
}
async function tgSetNotify(env, me, b) {
  const mode = ['all', 'kids', 'off'].indexOf(b.mode) >= 0 ? b.mode : 'all';
  const rev = await bumpRev(env);
  await env.DB.prepare('UPDATE members SET tg_notify=?, rev=? WHERE id=?').bind(mode, rev, me.id).run();
  return { members: await membersFull(env) };
}
async function tgUnlink(env, me) {
  const rev = await bumpRev(env);
  await env.DB.prepare('UPDATE members SET tg_chat_id=NULL, rev=? WHERE id=?').bind(rev, me.id).run();
  return { members: await membersFull(env) };
}

function tgButtons(env, msgId) {
  return {
    inline_keyboard: [
      [{ text: '👍', callback_data: 'r:' + msgId + ':👍' }, { text: '❤️', callback_data: 'r:' + msgId + ':❤️' }, { text: '💬 Giỏi lắm!', callback_data: 'q:' + msgId }],
      [{ text: '📱 Mở Nhà Mình', url: appUrl(env) }]
    ]
  };
}
async function tgSendAndMap(env, chatId, convId, msgId, method, payload) {
  const r = await tg(env, method, Object.assign({ chat_id: chatId, parse_mode: 'HTML', reply_markup: tgButtons(env, msgId) }, payload));
  if (r && r.ok) {
    await env.DB.batch([
      env.DB.prepare('INSERT OR REPLACE INTO tg_map (chat_id, tg_msg_id, conv_id, msg_id, created_at) VALUES (?,?,?,?,?)')
        .bind(String(chatId), String(r.result.message_id), convId, msgId, Date.now()),
      env.DB.prepare('DELETE FROM tg_map WHERE created_at < ?').bind(Date.now() - 60 * DAY)
    ]);
  }
  return r;
}

async function notifyNewMessage(env, origin, msg, sender) {
  const mem = await convMembers(env, msg.conv_id);
  const senderRow = mem.find(x => x.id === sender.id) || sender;
  const targets = mem.filter(x => x.id !== sender.id && x.tg_chat_id && x.tg_notify !== 'off' &&
    (x.tg_notify === 'all' || senderRow.role === 'child'));
  if (!targets.length) return;
  const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id=?').bind(msg.conv_id).first();
  const atts = (await env.DB.prepare('SELECT * FROM attachments WHERE msg_id=? ORDER BY id').bind(msg.id).all()).results;
  const where = conv.type === 'group' ? '👨‍👩‍👧‍👧 ' + (conv.name || 'Gia đình') : '🔒 nhắn riêng';
  let lines = ['<b>' + esc(senderRow.avatar + ' ' + senderRow.name) + '</b> · ' + esc(where)];
  if (msg.hw_for) {
    const who = msg.hw_for === 'all' ? 'cả hai bé' : ((mem.find(x => x.id === msg.hw_for) || {}).name || '');
    lines.push('📚 <b>Bài tập</b> cho ' + esc(who) + (msg.hw_due ? ' · hạn ' + esc(msg.hw_due.split('-').reverse().join('/')) : ''));
  }
  if (msg.body) lines.push(esc(clip(msg.body, 800)));
  const icon = { image: '🖼️ Ảnh', video: '🎬 Video', voice: '🎤 Tin nhắn thoại', file: '📎' };
  atts.forEach(a => {
    if (a.kind === 'voice') lines.push('🎤 Tin nhắn thoại' + (a.dur ? ' (' + a.dur + ' giây)' : ''));
    else if (a.kind === 'file') lines.push('📎 ' + esc(a.name || 'Tệp'));
    else if (!(a.kind === 'image' && a === atts[0])) lines.push(icon[a.kind] + (a.name ? ' ' + esc(a.name) : ''));
  });
  lines.push('<i>↩️ Vuốt "Trả lời" tin này để nhắn lại</i>');
  const text = lines.join('\n');
  const firstImg = atts[0] && atts[0].kind === 'image' ? atts[0] : null;
  for (const t of targets) {
    if (firstImg) {
      const photo = await signedUrl(env, origin, firstImg.r2_key);
      const r = await tgSendAndMap(env, t.tg_chat_id, msg.conv_id, msg.id, 'sendPhoto', { photo, caption: clip(text, 1000) });
      if (r && r.ok) continue;
    }
    await tgSendAndMap(env, t.tg_chat_id, msg.conv_id, msg.id, 'sendMessage', { text, disable_web_page_preview: false });
  }
}

async function notifyHwDone(env, origin, msg, kid) {
  const parents = (await env.DB.prepare("SELECT * FROM members WHERE role='parent' AND tg_chat_id IS NOT NULL AND tg_notify != 'off'").all()).results;
  const inConv = await convMembers(env, msg.conv_id);
  const text = '✅ <b>' + esc(kid.avatar + ' ' + kid.name) + '</b> đã làm xong bài tập:\n' +
    (msg.body ? '“' + esc(clip(msg.body, 300)) + '”' : '(bài tập có tệp đính kèm)') +
    '\n<i>↩️ Trả lời tin này để khen con</i>';
  for (const p of parents) {
    if (!inConv.some(x => x.id === p.id)) continue;
    await tgSendAndMap(env, p.tg_chat_id, msg.conv_id, msg.id, 'sendMessage', { text });
  }
}

async function memberByChat(env, chatId) {
  return env.DB.prepare('SELECT * FROM members WHERE tg_chat_id=?').bind(String(chatId)).first();
}

async function tgWebhook(request, env, url, ctx) {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
  if (!safeEq(secret, await tgSecret(env))) return new Response('forbidden', { status: 403 });
  let up; try { up = await request.json(); } catch (e) { return new Response('ok'); }
  const origin = url.origin;
  try {
    if (up.callback_query) await tgCallback(env, origin, up.callback_query, ctx);
    else if (up.message) await tgMessage(env, origin, up.message, ctx);
  } catch (e) {
    console.log('tg webhook err', e && e.stack || e);
    const chatId = up.message ? up.message.chat.id : (up.callback_query && up.callback_query.message ? up.callback_query.message.chat.id : null);
    if (chatId) await tg(env, 'sendMessage', { chat_id: chatId, text: '⚠️ Không gửi được: ' + (e.message || e) });
  }
  return new Response('ok');
}

async function tgMessage(env, origin, m, ctx) {
  if (!m.chat || m.chat.type !== 'private') return;
  const chatId = String(m.chat.id);
  const text = String(m.text || m.caption || '');

  if (/^\/start\b/.test(text)) {
    const code = text.split(/\s+/)[1] || '';
    const link = code ? await env.DB.prepare('SELECT * FROM tg_links WHERE code=? AND expires > ?').bind(code, Date.now()).first() : null;
    if (!link) {
      await tg(env, 'sendMessage', { chat_id: chatId, text: '🏠 Bot này chỉ dành cho gia đình dùng app Nhà Mình.\nHãy kết nối từ app: Cài đặt → Kết nối Telegram.' });
      return;
    }
    const rev = await bumpRev(env);
    await env.DB.batch([
      env.DB.prepare('UPDATE members SET tg_chat_id=NULL WHERE tg_chat_id=?').bind(chatId),
      env.DB.prepare('UPDATE members SET tg_chat_id=?, rev=? WHERE id=?').bind(chatId, rev, link.member_id),
      env.DB.prepare('DELETE FROM tg_links WHERE code=?').bind(code)
    ]);
    const mem = await env.DB.prepare('SELECT * FROM members WHERE id=?').bind(link.member_id).first();
    await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: '✅ Đã kết nối Nhà Mình với <b>' + esc(mem.avatar + ' ' + mem.name) + '</b>.\n\nKhi có tin mới, bot sẽ báo ở đây. Muốn nhắn lại, hãy vuốt <b>Trả lời</b> vào thông báo đó.' });
    return;
  }

  const mem = await memberByChat(env, chatId);
  if (!mem) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: '🏠 Bot này chỉ dành cho gia đình dùng app Nhà Mình.' });
    return;
  }
  const rt = m.reply_to_message;
  const map = rt ? await env.DB.prepare('SELECT * FROM tg_map WHERE chat_id=? AND tg_msg_id=?').bind(chatId, String(rt.message_id)).first() : null;
  if (!map) {
    await tg(env, 'sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: '💡 Để gửi tin vào Nhà Mình, hãy vuốt <b>Trả lời</b> vào một thông báo của bot — tin sẽ vào đúng cuộc trò chuyện đó.', reply_markup: { inline_keyboard: [[{ text: '📱 Mở Nhà Mình', url: appUrl(env) }]] } });
    return;
  }
  const atts = [];
  if (m.photo && m.photo.length) {
    const big = m.photo[m.photo.length - 1];
    const f = await tg(env, 'getFile', { file_id: big.file_id });
    if (f.ok) {
      const res = await fetch('https://api.telegram.org/file/bot' + (await tgToken(env)) + '/' + f.result.file_path);
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size <= MAX_FILE) {
          const key = await putFile(env, blob, 'anh-telegram.jpg', 'image/jpeg');
          const r = await env.DB.prepare('INSERT INTO attachments (msg_id, uploader, kind, r2_key, name, mime, size, w, h, created_at) VALUES (NULL,?,?,?,?,?,?,?,?,?) RETURNING id')
            .bind(mem.id, 'image', key, 'anh-telegram.jpg', 'image/jpeg', blob.size, big.width || null, big.height || null, Date.now()).first();
          atts.push(r.id);
        }
      }
    }
  }
  if (!text.trim() && !atts.length) {
    await tg(env, 'sendMessage', { chat_id: chatId, text: 'Hiện chỉ gửi được chữ hoặc ảnh từ Telegram. Tin thoại/tệp hãy gửi trong app nhé.' });
    return;
  }
  await createMessage(env, mem, origin, { conv: map.conv_id, text: text, atts: atts, reply_to: map.msg_id, via: 'telegram' }, ctx);
  await tg(env, 'setMessageReaction', { chat_id: chatId, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👌' }] });
}

async function tgCallback(env, origin, q, ctx) {
  const mem = await memberByChat(env, q.from.id);
  if (!mem) { await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Chưa kết nối tài khoản' }); return; }
  const parts = String(q.data || '').split(':');
  const msgId = int(parts[1]);
  const msg = await env.DB.prepare('SELECT * FROM messages WHERE id=?').bind(msgId).first();
  if (!msg) { await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Tin không còn' }); return; }
  await assertMember(env, mem, msg.conv_id);
  if (parts[0] === 'r') {
    await setReaction(env, mem, msgId, parts.slice(2).join(':'));
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Đã thả ' + parts.slice(2).join(':') });
  } else if (parts[0] === 'q') {
    await createMessage(env, mem, origin, { conv: msg.conv_id, text: 'Giỏi lắm! 👍', reply_to: msgId, via: 'telegram' }, ctx);
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Đã gửi "Giỏi lắm! 👍"' });
  } else {
    await tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
  }
}

/* ------------------------------------------------------------------ */
/*  Thời gian thực: Durable Object "Hub" (WebSocket, có ngủ đông)        */
/*  Hub chỉ chuyển "có tin mới (rev)", "đang soạn tin", "đang trực tuyến".*/
/*  Nội dung tin vẫn lấy qua /api/sync nên WebSocket rớt cũng không mất tin.*/
/* ------------------------------------------------------------------ */
const MAX_SOCKETS_PER_MEMBER = 4;

function hubStub(env) {
  if (!env.HUB) return null;
  return env.HUB.get(env.HUB.idFromName('family'));
}
async function pokeHub(env) {
  const stub = hubStub(env);
  if (!stub) return;
  const r = await env.DB.prepare("SELECT v FROM meta WHERE k='rev'").first();
  await stub.fetch('https://hub/poke', { method: 'POST', body: JSON.stringify({ rev: Number(r && r.v) || 0 }) });
}
/** Danh sách thành viên đang mở app (tab đang hiện) → khỏi gửi Web Push cho họ */
async function hubVisible(env) {
  const stub = hubStub(env);
  if (!stub) return [];
  try {
    const r = await stub.fetch('https://hub/visible');
    const j = await r.json();
    return Array.isArray(j.visible) ? j.visible : [];
  } catch (e) { return []; }
}

async function wsConnect(request, env) {
  if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('Cần WebSocket', { status: 426 });
  if (!env.HUB) return new Response('Chưa bật thời gian thực', { status: 501 });
  const protos = String(request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map(x => x.trim());
  const tok = protos.find(x => x.startsWith('tok.'));
  const me = await authToken(env, tok ? tok.slice(4) : '');
  return hubStub(env).fetch('https://hub/ws', { headers: { Upgrade: 'websocket', 'X-Member': me.id } });
}

export class Hub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.convCache = new Map();
    try { state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (e) { /* môi trường test */ }
  }
  socks() { return this.state.getWebSockets(); }
  info(ws) { try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; } }
  visibleList(except) {
    const set = new Set();
    for (const ws of this.socks()) {
      if (ws === except) continue;
      const a = this.info(ws);
      if (a.m && a.v) set.add(a.m);
    }
    return Array.from(set);
  }
  broadcast(obj, only, except) {
    const s = JSON.stringify(obj);
    for (const ws of this.socks()) {
      if (ws === except) continue;
      if (only && !only.includes(this.info(ws).m)) continue;
      try { ws.send(s); } catch (e) { /* socket đã đóng */ }
    }
  }
  presence(except) { this.broadcast({ t: 'presence', online: this.visibleList(except) }, null, except); }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/poke') {
      let rev = 0; try { rev = (await request.json()).rev || 0; } catch (e) { /* bỏ qua */ }
      this.broadcast({ t: 'rev', rev });
      return new Response('ok');
    }
    if (url.pathname === '/visible') {
      return new Response(JSON.stringify({ visible: this.visibleList() }), { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/ws') {
      const member = request.headers.get('X-Member') || '';
      if (!member) return new Response('no member', { status: 400 });
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      // giới hạn số kết nối mỗi người: đóng cái cũ nhất
      const mine = this.socks().filter(w => this.info(w).m === member);
      while (mine.length >= MAX_SOCKETS_PER_MEMBER) { try { mine.shift().close(1000, 'replaced'); } catch (e) { /* ok */ } }
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ m: member, v: 1 });
      try { server.send(JSON.stringify({ t: 'hello', online: this.visibleList() })); } catch (e) { /* ok */ }
      this.presence();
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': 'nha.v1' } });
    }
    return new Response('not found', { status: 404 });
  }

  async convPeers(conv) {
    let ids = this.convCache.get(conv);
    if (!ids) {
      const r = await this.env.DB.prepare('SELECT member_id FROM conv_members WHERE conv_id=?').bind(conv).all();
      ids = r.results.map(x => x.member_id);
      if (this.convCache.size > 50) this.convCache.clear();
      this.convCache.set(conv, ids);
    }
    return ids;
  }
  async webSocketMessage(ws, data) {
    let msg; try { msg = JSON.parse(String(data)); } catch (e) { return; }
    const a = this.info(ws);
    if (!a.m || !msg) return;
    if (msg.t === 'vis') {
      const v = msg.v ? 1 : 0;
      if (v !== a.v) { ws.serializeAttachment({ m: a.m, v }); this.presence(); }
    } else if (msg.t === 'typing') {
      const conv = String(msg.conv || '');
      const peers = await this.convPeers(conv);
      if (!peers.includes(a.m)) return;
      this.broadcast({ t: 'typing', conv, m: a.m }, peers.filter(x => x !== a.m), ws);
    }
  }
  async webSocketClose(ws) {
    try { ws.close(); } catch (e) { /* ok */ }
    this.presence(ws);
  }
  async webSocketError(ws) { this.presence(ws); }
}

/* ------------------------------------------------------------------ */
/*  Web Push (VAPID + mã hóa aes128gcm, tự làm bằng WebCrypto)           */
/* ------------------------------------------------------------------ */
function b64uEnc(buf) {
  const a = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ''; for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDec(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str); const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
function concatBytes() {
  let n = 0; for (const x of arguments) n += x.length;
  const out = new Uint8Array(n); let o = 0;
  for (const x of arguments) { out.set(x, o); o += x.length; }
  return out;
}

let _vapid = null;
/** Cặp khóa VAPID: tự sinh 1 lần, lưu trong D1. ĐỪNG xóa — xóa là mọi thiết bị phải bật lại thông báo. */
async function getVapid(env) {
  if (_vapid) return _vapid;
  let r = await env.DB.prepare("SELECT v FROM meta WHERE k='vapid'").first();
  if (!r) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
    const pub = b64uEnc(await crypto.subtle.exportKey('raw', kp.publicKey));
    await env.DB.prepare("INSERT OR IGNORE INTO meta (k, v) VALUES ('vapid', ?)").bind(JSON.stringify({ pub, jwk })).run();
    r = await env.DB.prepare("SELECT v FROM meta WHERE k='vapid'").first();
  }
  const o = JSON.parse(r.v);
  const key = await crypto.subtle.importKey('jwk', o.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  _vapid = { pub: o.pub, key };
  return _vapid;
}
async function vapidAuth(env, endpoint) {
  const v = await getVapid(env);
  const enc = x => b64uEnc(new TextEncoder().encode(JSON.stringify(x)));
  const head = enc({ typ: 'JWT', alg: 'ES256' });
  const claims = enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: appUrl(env) });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, v.key, new TextEncoder().encode(head + '.' + claims));
  return 'vapid t=' + head + '.' + claims + '.' + b64uEnc(sig) + ', k=' + v.pub;
}
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
/** RFC 8291 (aes128gcm). sub = { p256dh, auth } dạng base64url */
export async function encryptPush(sub, plain) {
  const uaPub = b64uDec(sub.p256dh), authSecret = b64uDec(sub.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const te = new TextEncoder();
  const prk = await hkdf(authSecret, shared, concatBytes(te.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, prk, te.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, prk, te.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concatBytes(plain, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // 4096
  return concatBytes(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

async function sendPush(env, sub, payload, opts) {
  opts = opts || {};
  const body = await encryptPush(sub, new TextEncoder().encode(JSON.stringify(payload)));
  let res;
  try {
    res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': String(opts.ttl || 86400),
        'Urgency': opts.urgency || 'normal',
        'Authorization': await vapidAuth(env, sub.endpoint)
      },
      body
    });
  } catch (e) { return 0; }
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint=?').bind(sub.endpoint).run();
  }
  return res.status;
}

async function pushSubscribe(env, me, b, request) {
  const ep = String(b.endpoint || '');
  const k = b.keys || {};
  let u; try { u = new URL(ep); } catch (e) { u = null; }
  if (!u || u.protocol !== 'https:' || ep.length > 800) throw httpErr(400, 'Địa chỉ thông báo không hợp lệ');
  if (!k.p256dh || !k.auth || String(k.p256dh).length > 200 || String(k.auth).length > 100) throw httpErr(400, 'Khóa thông báo không hợp lệ');
  await env.DB.batch([
    env.DB.prepare('INSERT INTO push_subs (endpoint, member_id, p256dh, auth, ua, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET member_id=excluded.member_id, p256dh=excluded.p256dh, auth=excluded.auth, ua=excluded.ua')
      .bind(ep, me.id, String(k.p256dh), String(k.auth), clip(b.ua || request.headers.get('User-Agent') || '', 120), Date.now()),
    env.DB.prepare('DELETE FROM push_subs WHERE member_id=? AND endpoint NOT IN (SELECT endpoint FROM push_subs WHERE member_id=? ORDER BY created_at DESC LIMIT 6)').bind(me.id, me.id)
  ]);
  return { ok: true };
}
async function pushUnsubscribe(env, me, b) {
  await env.DB.prepare('DELETE FROM push_subs WHERE endpoint=? AND member_id=?').bind(String(b.endpoint || ''), me.id).run();
  return { ok: true };
}

async function unreadFor(env, memberId) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages m
       JOIN conv_members cm ON cm.conv_id=m.conv_id AND cm.member_id=?1
       LEFT JOIN reads r ON r.conv_id=m.conv_id AND r.member_id=?1
      WHERE m.sender_id != ?1 AND m.recalled_at IS NULL AND m.id > COALESCE(r.last_read_id, 0)`).bind(memberId).first();
  return r ? r.n : 0;
}
async function pushToMembers(env, memberIds, build, opts) {
  if (!memberIds.length) return;
  const subs = (await env.DB.prepare('SELECT * FROM push_subs WHERE member_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(memberIds)).all()).results;
  if (!subs.length) return;
  const cache = {};
  for (const s of subs) {
    if (!cache[s.member_id]) cache[s.member_id] = await build(s.member_id);
    await sendPush(env, s, cache[s.member_id], opts);
  }
}

async function pushNewMessage(env, msg, sender) {
  const mem = await convMembers(env, msg.conv_id);
  const senderRow = mem.find(x => x.id === sender.id) || sender;
  const hasSub = (await env.DB.prepare('SELECT DISTINCT member_id FROM push_subs').all()).results.map(x => x.member_id);
  if (!hasSub.length) return;
  const visible = await hubVisible(env);
  const targets = mem.filter(x => x.id !== sender.id && hasSub.includes(x.id) && !visible.includes(x.id)).map(x => x.id);
  if (!targets.length) return;
  const conv = await env.DB.prepare('SELECT * FROM conversations WHERE id=?').bind(msg.conv_id).first();
  const atts = (await env.DB.prepare('SELECT kind, name, dur FROM attachments WHERE msg_id=? ORDER BY id').bind(msg.id).all()).results;
  let preview = msg.body ? clip(msg.body, 140) : '';
  if (!preview && atts.length) {
    const a = atts[0];
    preview = a.kind === 'image' ? '🖼️ Ảnh' : a.kind === 'video' ? '🎬 Video' : a.kind === 'voice' ? '🎤 Tin nhắn thoại' : '📎 ' + (a.name || 'Tệp');
  }
  if (msg.hw_for) preview = '📚 Bài tập: ' + (preview || '(xem trong app)');
  const title = senderRow.avatar + ' ' + senderRow.name + (conv && conv.type === 'group' ? ' · ' + (conv.name || 'Gia đình') : '');
  await pushToMembers(env, targets, async id => ({
    title, body: preview, conv: msg.conv_id, msg: msg.id, tag: 'c-' + msg.conv_id, badge: await unreadFor(env, id)
  }), { urgency: 'high' });
}

async function pushHwDone(env, msg, kid) {
  const inConv = await convMembers(env, msg.conv_id);
  const parents = inConv.filter(x => x.role === 'parent').map(x => x.id);
  const visible = await hubVisible(env);
  const targets = parents.filter(x => !visible.includes(x));
  await pushToMembers(env, targets, async id => ({
    title: '✅ ' + kid.avatar + ' ' + kid.name + ' đã làm xong bài tập',
    body: msg.body ? clip(msg.body, 120) : '(bài tập có tệp đính kèm)',
    conv: msg.conv_id, msg: msg.id, tag: 'hw-' + msg.id, badge: await unreadFor(env, id)
  }), { urgency: 'high' });
}
