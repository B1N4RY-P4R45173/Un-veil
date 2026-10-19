-- Unveil database schema. Idempotent: safe to run on every deploy.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS colleges (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email_domain  TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  college_id      INTEGER REFERENCES colleges(id),
  role            TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'admin')),
  status          TEXT NOT NULL DEFAULT 'pending',
  bio             TEXT NOT NULL DEFAULT '',
  interests       TEXT[] NOT NULL DEFAULT '{}',
  personality     TEXT[] NOT NULL DEFAULT '{}',
  trust_score     INTEGER NOT NULL DEFAULT 50 CHECK (trust_score BETWEEN 0 AND 100),
  warnings        INTEGER NOT NULL DEFAULT 0,
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Columns and constraints added after the first release (safe to re-run).
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
-- Admin correction to the shown report count (shown = real reports + offset, never below 0).
ALTER TABLE users ADD COLUMN IF NOT EXISTS report_offset INTEGER NOT NULL DEFAULT 0;
-- Microsoft account object ID, set for students who sign in with Microsoft (their name is then locked).
ALTER TABLE users ADD COLUMN IF NOT EXISTS ms_oid TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_ms_oid_idx ON users (ms_oid) WHERE ms_oid IS NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('pending', 'active', 'suspended', 'banned', 'deleted'));

CREATE TABLE IF NOT EXISTS email_otps (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL CHECK (mode IN ('campus', 'cross')),
  filter      TEXT NOT NULL CHECK (filter IN ('interest', 'personality', 'mystery')),
  alias_a     TEXT NOT NULL,
  alias_b     TEXT NOT NULL,
  consent_a   BOOLEAN NOT NULL DEFAULT false,
  consent_b   BOOLEAN NOT NULL DEFAULT false,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revealed_at TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  ended_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  end_reason  TEXT
);
CREATE INDEX IF NOT EXISTS chat_sessions_user_a_idx ON chat_sessions (user_a, started_at DESC);
CREATE INDEX IF NOT EXISTS chat_sessions_user_b_idx ON chat_sessions (user_b, started_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  sender_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  blocked     BOOLEAN NOT NULL DEFAULT false,
  moderation  JSONB,
  deleted     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session_id, id);

CREATE TABLE IF NOT EXISTS friendships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  CHECK (requester <> addressee)
);
-- One friendship row per unordered pair.
CREATE UNIQUE INDEX IF NOT EXISTS friendships_pair_idx
  ON friendships (LEAST(requester, addressee), GREATEST(requester, addressee));

CREATE TABLE IF NOT EXISTS blocks (
  blocker     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id  UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker, blocked)
);

CREATE TABLE IF NOT EXISTS reports (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id  UUID REFERENCES users(id) ON DELETE SET NULL,   -- NULL when raised by AI moderation
  reported_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id   UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
  source       TEXT NOT NULL CHECK (source IN ('user', 'ai')),
  reason       TEXT NOT NULL,
  details      TEXT NOT NULL DEFAULT '',
  severity     TEXT NOT NULL DEFAULT 'low' CHECK (severity IN ('low', 'medium', 'high')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'warned', 'suspended', 'banned')),
  admin_note   TEXT,
  resolved_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  ip          TEXT,
  meta        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);
