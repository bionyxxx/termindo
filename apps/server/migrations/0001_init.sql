-- Termindo sync server schema. Timestamps are Unix milliseconds.

CREATE TABLE users (
    id                    TEXT PRIMARY KEY,
    email                 TEXT NOT NULL UNIQUE,
    -- Argon2id PHC string of the client's auth key (itself derived from the master password).
    auth_hash             TEXT NOT NULL,
    kdf_salt              TEXT NOT NULL,
    kdf_m                 INTEGER NOT NULL,
    kdf_t                 INTEGER NOT NULL,
    kdf_p                 INTEGER NOT NULL,
    -- DEK sealed client-side; opaque to the server.
    wrapped_dek           TEXT NOT NULL,
    wrapped_dek_recovery  TEXT,
    -- Argon2id PHC string of the recovery auth key.
    recovery_auth_hash    TEXT,
    created_at            BIGINT NOT NULL,
    updated_at            BIGINT NOT NULL
);

CREATE TABLE devices (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    created_at    BIGINT NOT NULL,
    last_seen_at  BIGINT NOT NULL,
    revoked_at    BIGINT
);
CREATE INDEX devices_user ON devices(user_id);

CREATE TABLE refresh_tokens (
    -- SHA-256 (hex) of the random token; the token itself is never stored.
    token_hash  TEXT PRIMARY KEY,
    device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  BIGINT NOT NULL,
    expires_at  BIGINT NOT NULL,
    used_at     BIGINT
);
CREATE INDEX refresh_tokens_device ON refresh_tokens(device_id);

-- Global, strictly increasing change counter used as the pull cursor.
CREATE SEQUENCE record_seq;

CREATE TABLE records (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    seq         BIGINT NOT NULL UNIQUE,
    updated_at  BIGINT NOT NULL,
    deleted     BOOLEAN NOT NULL DEFAULT FALSE,
    blob        TEXT NOT NULL,
    device_id   TEXT,
    PRIMARY KEY (user_id, id)
);
CREATE INDEX records_user_seq ON records(user_id, seq);
