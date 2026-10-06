// Datenbank-Schema als Liste von Migrationen. Nie alte Einträge ändern, nur neue anhängen.
export const MIGRATIONS = [
  // 1: Grundlage
  [
    `CREATE TABLE users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      recovery_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`,
    `CREATE TABLE devices (
      secret_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      last_seen TEXT
    )`,
    `CREATE INDEX idx_devices_user ON devices(user_id)`,
    `CREATE INDEX idx_users_recovery ON users(recovery_hash)`,
    `CREATE TABLE trips (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      cover BLOB,
      cover_type TEXT,
      cover_version INTEGER NOT NULL DEFAULT 0,
      owner_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE members (
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
      joined_at TEXT NOT NULL,
      PRIMARY KEY (trip_id, user_id)
    )`,
    `CREATE INDEX idx_members_user ON members(user_id)`,
    `CREATE TABLE stops (
      id TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      lat REAL NOT NULL,
      lon REAL NOT NULL,
      planned_date TEXT,
      visited_at TEXT,
      visited_by TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX idx_stops_trip ON stops(trip_id, position)`,
    `CREATE TABLE invites (
      token TEXT PRIMARY KEY,
      trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX idx_invites_trip ON invites(trip_id)`,
  ],
];
