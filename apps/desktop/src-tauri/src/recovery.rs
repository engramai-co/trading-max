use std::time::Duration;

#[derive(Default)]
pub struct RemoteRecovery {
    connected: bool,
    failures: usize,
}

pub struct Retry {
    pub show_recovery: bool,
    pub after: Option<Duration>,
}

impl RemoteRecovery {
    pub fn recovered(&mut self) {
        self.connected = true;
        self.failures = 0;
    }

    pub fn failed(&mut self) -> Retry {
        self.failures += 1;
        // Initial connection gets two extra attempts; a live connection tolerates
        // one transient miss before showing recovery. Neither retries forever.
        let delays: &[u64] = if self.connected {
            &[15, 30, 60]
        } else {
            &[5, 15]
        };
        Retry {
            show_recovery: !self.connected || self.failures >= 2,
            after: delays
                .get(self.failures - 1)
                .copied()
                .map(Duration::from_secs),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_connection_is_bounded_and_keeps_recovery_available() {
        let mut policy = RemoteRecovery::default();
        for expected in [Some(5), Some(15), None, None] {
            let retry = policy.failed();
            assert!(retry.show_recovery);
            assert_eq!(retry.after.map(|delay| delay.as_secs()), expected);
        }
    }

    #[test]
    fn live_connection_tolerates_one_miss_and_success_resets_the_budget() {
        let mut policy = RemoteRecovery::default();
        policy.recovered();
        assert!(!policy.failed().show_recovery);
        assert!(policy.failed().show_recovery);
        assert_eq!(policy.failed().after.unwrap().as_secs(), 60);
        assert!(policy.failed().after.is_none());
        policy.recovered();
        let retry = policy.failed();
        assert!(!retry.show_recovery);
        assert_eq!(retry.after.unwrap().as_secs(), 15);
    }
}
