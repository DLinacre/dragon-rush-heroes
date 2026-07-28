-- ============================================================================
-- Dragon Ball Heroes — PostgreSQL schema
-- ============================================================================
--
-- The shipped build uses an embedded WAL document store (server/data/store.js)
-- so the app runs with zero dependencies. This DDL is the canonical relational
-- model for the scale-out path: it mirrors the document shapes exactly, so
-- migrating means reimplementing server/data/repositories.js against `pg` and
-- nothing else.
--
-- Conventions
--   * Identifiers are TEXT prefixed by type (usr_, ses_, rst_) — human-readable
--     in logs and impossible to confuse across tables.
--   * Every table carries created_at; mutable tables carry updated_at.
--   * Money-like values are BIGINT (never floating point).
--   * Deletes cascade from the user, which is what makes GDPR erasure a
--     single statement.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- enums ----

CREATE TYPE user_status   AS ENUM ('active', 'suspended', 'deleted');
CREATE TYPE battle_status AS ENUM ('active', 'complete', 'forfeit', 'abandoned');
CREATE TYPE currency_kind AS ENUM ('crystals', 'zeni', 'souls');
CREATE TYPE rarity_kind   AS ENUM ('HERO', 'EXTREME', 'SPARKING', 'LEGENDS', 'ULTRA');

-- ---------------------------------------------------------------- users ----

CREATE TABLE users (
    id             TEXT        PRIMARY KEY,
    email          TEXT        NOT NULL,
    -- Encoded as scrypt$N$r$p$salt$hash. Never leaves the database.
    password_hash  TEXT        NOT NULL,
    status         user_status NOT NULL DEFAULT 'active',
    failed_logins  INTEGER     NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
    locked_until   TIMESTAMPTZ,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness: Hero@x.com and hero@x.com are the same account.
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));
CREATE INDEX users_status_idx ON users (status) WHERE status <> 'active';

COMMENT ON TABLE users IS 'Authentication identities. Game state lives in players.';

-- ------------------------------------------------------------- sessions ----

CREATE TABLE sessions (
    id           TEXT        PRIMARY KEY,
    user_id      TEXT        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- SHA-256 of the opaque bearer token. The raw token is never persisted,
    -- so a database disclosure cannot be replayed as a valid login.
    token_hash   TEXT        NOT NULL UNIQUE,
    ip           INET,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ
);

CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_live_idx    ON sessions (expires_at) WHERE revoked_at IS NULL;

-- -------------------------------------------------------------- players ----

CREATE TABLE players (
    id            TEXT        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    display_name  TEXT        NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 20),
    level         INTEGER     NOT NULL DEFAULT 1  CHECK (level >= 1),
    xp            BIGINT      NOT NULL DEFAULT 0  CHECK (xp >= 0),

    -- Currencies. Non-negative constraints are the last line of defence
    -- against an economy exploit slipping past the service layer.
    crystals      BIGINT      NOT NULL DEFAULT 25000 CHECK (crystals >= 0),
    zeni          BIGINT      NOT NULL DEFAULT 500000 CHECK (zeni >= 0),
    souls         BIGINT      NOT NULL DEFAULT 5000  CHECK (souls >= 0),

    -- The Legends Pass is granted free and permanently to every account.
    -- pass_expires_at IS NULL means "never expires" — enforced by the CHECK.
    pass_active     BOOLEAN     NOT NULL DEFAULT TRUE,
    pass_tier       TEXT        NOT NULL DEFAULT 'LEGENDS_PASS_FREE',
    pass_granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    pass_expires_at TIMESTAMPTZ CHECK (pass_expires_at IS NULL),

    -- Stamina is modelled for UI parity but never consumed in this build.
    stamina_unlimited BOOLEAN   NOT NULL DEFAULT TRUE,

    -- Gacha pity counters.
    pity_since_sparking INTEGER NOT NULL DEFAULT 0 CHECK (pity_since_sparking >= 0),
    pity_since_legends  INTEGER NOT NULL DEFAULT 0 CHECK (pity_since_legends  >= 0),

    -- Provably-fair chain state.
    client_seed   TEXT        NOT NULL,
    summon_nonce  BIGINT      NOT NULL DEFAULT 0 CHECK (summon_nonce >= 0),

    -- Denormalised counters driving mission progress.
    counters      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    claimed_missions JSONB    NOT NULL DEFAULT '{}'::jsonb,
    cleared_stages   JSONB    NOT NULL DEFAULT '{}'::jsonb,
    settings      JSONB       NOT NULL DEFAULT '{}'::jsonb,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX players_display_name_lower_key ON players (lower(display_name));
CREATE INDEX players_counters_gin ON players USING gin (counters);

COMMENT ON COLUMN players.pass_expires_at IS
    'Always NULL. The CHECK constraint makes the free-forever pass a database-level guarantee.';

-- -------------------------------------------------------- roster entries ----

CREATE TABLE roster_entries (
    id          TEXT        PRIMARY KEY,
    player_id   TEXT        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    -- References a fighter generated deterministically by domain/content.js.
    -- Not an FK: the catalogue is code, not data, which keeps content
    -- deployment atomic with the application version.
    fighter_id  TEXT        NOT NULL,
    level       INTEGER     NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 110),
    z_power     BIGINT      NOT NULL DEFAULT 0 CHECK (z_power >= 0),
    stars       SMALLINT    NOT NULL DEFAULT 0 CHECK (stars BETWEEN 0 AND 7),
    soul_boosts JSONB       NOT NULL DEFAULT '{}'::jsonb,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A player holds at most one row per fighter; duplicates become z_power.
    CONSTRAINT roster_unique_fighter UNIQUE (player_id, fighter_id)
);

CREATE INDEX roster_player_idx ON roster_entries (player_id);

-- ---------------------------------------------------------------- teams ----

CREATE TABLE teams (
    id         TEXT        PRIMARY KEY,
    player_id  TEXT        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    slot_index SMALLINT    NOT NULL CHECK (slot_index BETWEEN 0 AND 5),
    name       TEXT        NOT NULL DEFAULT 'Squad',
    -- Ordered fighter ids; length is validated in the service layer.
    members    TEXT[]      NOT NULL CHECK (cardinality(members) BETWEEN 1 AND 3),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT teams_unique_slot UNIQUE (player_id, slot_index)
);

-- -------------------------------------------------------------- battles ----

CREATE TABLE battles (
    id         TEXT          PRIMARY KEY,
    player_id  TEXT          NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    stage_id   TEXT,
    status     battle_status NOT NULL DEFAULT 'active',
    winner     TEXT          CHECK (winner IN ('player', 'enemy')),
    -- Full engine state. Combined with the seed this makes a battle
    -- reconstructible and replayable for dispute resolution.
    snapshot   JSONB         NOT NULL,
    created_at TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX battles_player_idx ON battles (player_id);
-- Enforces the "one battle at a time" rule at the storage layer.
CREATE UNIQUE INDEX battles_one_active_per_player
    ON battles (player_id) WHERE status = 'active';
CREATE INDEX battles_cleanup_idx ON battles (updated_at) WHERE status <> 'active';

-- --------------------------------------------------------------- ledger ----

CREATE TABLE ledger (
    id            BIGSERIAL     PRIMARY KEY,
    player_id     TEXT          NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    currency      currency_kind NOT NULL,
    delta         BIGINT        NOT NULL,
    balance_after BIGINT        NOT NULL CHECK (balance_after >= 0),
    reason        TEXT          NOT NULL,
    ref_id        TEXT,
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX ledger_player_time_idx ON ledger (player_id, created_at DESC);

COMMENT ON TABLE ledger IS
    'Append-only audit trail. Every currency movement is recorded, so any '
    'balance can be reconstructed and economy exploits are detectable.';

-- Enforce append-only.
--
-- IMPORTANT: this must NOT be implemented with `CREATE RULE ... DO INSTEAD
-- NOTHING`. A DO-INSTEAD-NOTHING rule rewrites PostgreSQL's internal
-- referential-integrity probe, which makes the ON DELETE CASCADE from
-- players/users fail with "referential integrity query gave unexpected
-- result" — i.e. it silently breaks GDPR account erasure.
--
-- A BEFORE trigger blocks direct tampering while leaving cascades intact:
-- during a cascade `pg_trigger_depth() > 1`, so we allow the delete through
-- only when it originates from a parent-row deletion.
CREATE OR REPLACE FUNCTION ledger_guard() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'ledger is append-only: rows cannot be modified';
    END IF;
    -- TG_OP = 'DELETE'
    IF pg_trigger_depth() <= 1 THEN
        RAISE EXCEPTION 'ledger is append-only: rows cannot be deleted directly '
                        '(delete the owning user to erase an account)';
    END IF;
    RETURN OLD;  -- permit the cascade
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_append_only
    BEFORE UPDATE OR DELETE ON ledger
    FOR EACH ROW EXECUTE FUNCTION ledger_guard();

-- -------------------------------------------------------- summon history ----

CREATE TABLE summon_history (
    id           TEXT        PRIMARY KEY,
    player_id    TEXT        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    banner_id    TEXT        NOT NULL,
    pull_count   SMALLINT    NOT NULL CHECK (pull_count IN (1, 10)),
    results      JSONB       NOT NULL,
    -- { serverSeedHash, clientSeed, nonce, algorithm } — everything a player
    -- needs to recompute the outcome once the server seed is revealed.
    verification JSONB       NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX summon_history_player_idx ON summon_history (player_id, created_at DESC);

-- ------------------------------------------------------------- triggers ----

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_touch   BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER players_touch BEFORE UPDATE ON players
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER roster_touch  BEFORE UPDATE ON roster_entries
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER teams_touch   BEFORE UPDATE ON teams
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER battles_touch BEFORE UPDATE ON battles
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Keep roster stars consistent with accumulated Z-Power.
CREATE OR REPLACE FUNCTION sync_stars() RETURNS TRIGGER AS $$
BEGIN
    NEW.stars := CASE
        WHEN NEW.z_power >= 32000 THEN 7
        WHEN NEW.z_power >= 20000 THEN 6
        WHEN NEW.z_power >= 12000 THEN 5
        WHEN NEW.z_power >=  7000 THEN 4
        WHEN NEW.z_power >=  3500 THEN 3
        WHEN NEW.z_power >=  1500 THEN 2
        WHEN NEW.z_power >=   500 THEN 1
        ELSE 0
    END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER roster_sync_stars BEFORE INSERT OR UPDATE OF z_power ON roster_entries
    FOR EACH ROW EXECUTE FUNCTION sync_stars();

-- ----------------------------------------------------------------- views ----

-- Operational overview of a player's account.
CREATE VIEW player_overview AS
SELECT
    p.id,
    p.display_name,
    p.level,
    p.crystals,
    p.zeni,
    p.souls,
    p.pass_active,
    (p.pass_expires_at IS NULL) AS pass_is_permanent,
    COUNT(DISTINCT r.fighter_id)                                    AS fighters_owned,
    COUNT(DISTINCT r.fighter_id) FILTER (WHERE r.stars >= 5)        AS fighters_5_star_plus,
    COALESCE(MAX(r.level), 0)                                       AS highest_level,
    p.created_at
FROM players p
LEFT JOIN roster_entries r ON r.player_id = p.id
GROUP BY p.id;

-- Economy health: net currency flow per reason, for balance tuning.
CREATE VIEW economy_flow AS
SELECT
    currency,
    reason,
    COUNT(*)      AS events,
    SUM(delta)    AS net_delta,
    AVG(delta)::BIGINT AS avg_delta,
    date_trunc('day', created_at) AS day
FROM ledger
GROUP BY currency, reason, date_trunc('day', created_at);

-- Observed summon rates, for verifying the gacha against published numbers.
CREATE VIEW summon_rate_audit AS
SELECT
    banner_id,
    result ->> 'rarity'                     AS rarity,
    COUNT(*)                                AS pulls,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (PARTITION BY banner_id), 3) AS observed_pct
FROM summon_history, jsonb_array_elements(results) AS result
GROUP BY banner_id, result ->> 'rarity';

COMMIT;

-- ============================================================================
-- Maintenance
-- ============================================================================
-- Run periodically (pg_cron or an external scheduler):
--
--   DELETE FROM sessions
--    WHERE expires_at < now()
--       OR (revoked_at IS NOT NULL AND revoked_at < now() - INTERVAL '1 day');
--
--   DELETE FROM battles
--    WHERE status <> 'active' AND updated_at < now() - INTERVAL '24 hours';
--
-- GDPR erasure — cascades through every table:
--   DELETE FROM users WHERE id = $1;
-- ============================================================================
