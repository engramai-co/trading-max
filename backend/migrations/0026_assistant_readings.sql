CREATE TABLE assistant_readings (
    role TEXT NOT NULL,
    object_key TEXT NOT NULL,
    version TEXT NOT NULL,
    as_of TEXT NOT NULL,
    reading_json TEXT NOT NULL,
    PRIMARY KEY(role, object_key, version)
);
CREATE INDEX assistant_latest_reading ON assistant_readings(role, object_key, as_of DESC);
CREATE TABLE assistant_brief_attempts (
    day TEXT NOT NULL,
    role TEXT NOT NULL,
    object_key TEXT NOT NULL,
    slot TEXT NOT NULL,
    PRIMARY KEY(role, object_key, slot)
);
