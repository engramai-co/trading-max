use std::time::Duration;

#[derive(Default)]
pub struct RemoteRecovery {
    connected: bool,
    failures: usize,
}

impl RemoteRecovery {
    pub fn recovered(&mut self) {
        self.connected = true;
        self.failures = 0;
    }

    pub fn failed(&mut self, retryable: bool) -> Option<Duration> {
        if !retryable {
            return None;
        }
        self.failures = self.failures.saturating_add(1);
        // Retry transient outages for as long as the user keeps this connection
        // selected. Only one bounded request runs at a time; backoff caps load.
        let delays: &[u64] = if self.connected {
            &[15, 30, 60]
        } else {
            &[5, 15, 30, 60]
        };
        Some(Duration::from_secs(
            delays[(self.failures - 1).min(delays.len() - 1)],
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_connection_keeps_retrying_at_a_capped_rate() {
        let mut policy = RemoteRecovery::default();
        for expected in [5, 15, 30, 60, 60, 60] {
            assert_eq!(policy.failed(true).unwrap().as_secs(), expected);
        }
        policy.failures = usize::MAX;
        assert_eq!(policy.failed(true).unwrap().as_secs(), 60);
    }

    #[test]
    fn success_resets_backoff_and_permanent_errors_do_not_retry() {
        let mut policy = RemoteRecovery::default();
        assert!(policy.failed(false).is_none());
        policy.recovered();
        for expected in [15, 30, 60, 60, 60] {
            assert_eq!(policy.failed(true).unwrap().as_secs(), expected);
        }
        assert!(policy.failed(false).is_none());
        policy.recovered();
        assert_eq!(policy.failed(true).unwrap().as_secs(), 15);
    }
}
