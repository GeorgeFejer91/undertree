use super::*;
use std::time::Duration;
use tokio::sync::{watch, Semaphore};

pub(super) fn default_wait_ms() -> u64 {
    25_000
}

pub(super) struct ReviewChanges {
    sequence: watch::Sender<u64>,
    waiters: Semaphore,
}

impl Default for ReviewChanges {
    fn default() -> Self {
        Self {
            sequence: watch::channel(0).0,
            waiters: Semaphore::new(4),
        }
    }
}

impl ReviewChanges {
    pub(super) fn signal(&self) {
        self.sequence
            .send_modify(|sequence| *sequence = sequence.saturating_add(1));
    }
}

impl Service {
    pub(super) async fn wait_review_changes(
        &self,
        owner: &str,
        after: Option<String>,
        wait_ms: u64,
    ) -> Result<Value> {
        self.assert_editor_owner(owner)?;
        if wait_ms > default_wait_ms()
            || after.as_ref().is_some_and(|value| {
                value
                    .parse::<u64>()
                    .ok()
                    .is_none_or(|parsed| parsed.to_string() != *value)
            })
        {
            return Err(Error::new(
                "format",
                "Use a canonical review sequence and a wait of at most 25 seconds.",
            ));
        }
        let mut receiver = self.review_changes.sequence.subscribe();
        let current = receiver.borrow().to_string();
        if after.as_deref() == Some(current.as_str()) && wait_ms > 0 {
            let _permit = self.review_changes.waiters.try_acquire().map_err(|_| {
                Error::new("busy", "Four local review-change waits are already active.")
            })?;
            let _ = tokio::time::timeout(Duration::from_millis(wait_ms), receiver.changed()).await;
        }
        self.assert_editor_owner(owner)?;
        let sequence = receiver.borrow_and_update().to_string();
        Ok(
            json!({"instanceId":self.instance_id,"changed":after.as_deref()!=Some(sequence.as_str()),"sequence":sequence}),
        )
    }
}

#[cfg(test)]
mod tests;
