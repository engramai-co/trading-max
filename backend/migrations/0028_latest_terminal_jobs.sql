CREATE INDEX IF NOT EXISTS idx_jobs_scope_terminal
    ON jobs(scope, COALESCE(finished_at, started_at, created_at) DESC, created_at DESC, job_id DESC)
    WHERE trigger != 'system' AND status IN ('succeeded', 'failed', 'interrupted')
        AND cancel_requested = 0 AND error_code IS NOT 'job.cancelled';
