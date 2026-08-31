ALTER TABLE jobs ADD COLUMN scheduled_for TEXT;
ALTER TABLE jobs ADD COLUMN log_path TEXT;
ALTER TABLE jobs ADD COLUMN follow_up_research INTEGER NOT NULL DEFAULT 0
    CHECK (follow_up_research IN (0, 1));

ALTER TABLE job_stages ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE job_stages ADD COLUMN return_code INTEGER;
