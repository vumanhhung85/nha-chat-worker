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

CREATE TABLE IF NOT EXISTS calls (
  id           TEXT PRIMARY KEY,
  conv_id      TEXT NOT NULL,
  caller       TEXT NOT NULL,
  callee       TEXT NOT NULL,
  video        INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL DEFAULT 'ringing',   -- ringing | answered | ended | declined | missed
  created_at   INTEGER NOT NULL,
  answered_at  INTEGER,
  ended_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee, state);
CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls(caller, state);

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
