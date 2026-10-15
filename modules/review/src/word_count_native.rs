//! Local supplied-text analysis; no manuscript lookup, save or compiler invocation.
use crate::service::Service;
use crate::word_count::{collect_typst_literal, LiteralText, MAX_WORD_COUNT_TEXT};
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Semaphore;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WordCountRequest {
    owner_id: String,
    request_id: String,
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordCountReply {
    request_id: String,
    method: &'static str,
    #[serde(flatten)]
    estimate: LiteralText,
}

pub struct WordCountWorker {
    gate: Arc<Semaphore>,
}

impl Default for WordCountWorker {
    fn default() -> Self {
        Self {
            gate: Arc::new(Semaphore::new(1)),
        }
    }
}

impl WordCountWorker {
    async fn run(
        &self,
        analysis: impl FnOnce() -> Result<LiteralText> + Send + 'static,
    ) -> Result<LiteralText> {
        let permit = self.gate.clone().try_acquire_owned().map_err(|_| {
            Error::new(
                "busy",
                "A word count is still running. Try again when it finishes.",
            )
        })?;
        tokio::task::spawn_blocking(move || {
            // The worker retains admission even if its caller stops awaiting the result.
            let _permit = permit;
            analysis()
        })
        .await
        .map_err(|_| Error::new("state", "The word count could not finish. Try again."))?
    }

    pub async fn analyze(
        &self,
        service: &Arc<Service>,
        window_label: &str,
        request: WordCountRequest,
    ) -> Result<WordCountReply> {
        if window_label != "main" {
            return Err(Error::new(
                "forbidden",
                "Word count requires the local UnderTree window.",
            ));
        }
        let id = uuid::Uuid::parse_str(&request.request_id)
            .map_err(|_| Error::new("request", "Choose a valid word-count request identity."))?;
        if id.hyphenated().to_string() != request.request_id || request.owner_id.len() > 128 {
            return Err(Error::new(
                "request",
                "Choose a valid word-count request identity.",
            ));
        }
        if request.source.len() > MAX_WORD_COUNT_TEXT {
            return Err(Error::new(
                "limit",
                "Count a source file no larger than 2 MiB.",
            ));
        }
        let owner = service.native_editor_owner(window_label, &request.owner_id)?;
        let estimate = self
            .run(move || collect_typst_literal(&request.source))
            .await?;
        if service.native_editor_owner(window_label, &request.owner_id)? != owner {
            return Err(Error::new(
                "stale_session",
                "This editor page was replaced. Reopen word count from the current page.",
            ));
        }
        Ok(WordCountReply {
            request_id: request.request_id,
            method: "typst-literal-v1",
            estimate,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(owner: &str, source: &str) -> WordCountRequest {
        WordCountRequest {
            owner_id: owner.into(),
            request_id: uuid::Uuid::new_v4().to_string(),
            source: source.into(),
        }
    }

    #[tokio::test]
    async fn local_supplied_text_reply_preserves_request_identity_and_never_changes_state() {
        let temp = tempfile::tempdir().unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let owner = service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        let registry = std::fs::read(temp.path().join("state/projects.json")).ok();
        let worker = WordCountWorker::default();
        for source in ["= Heading\nHello *world*.", "#let x = ["] {
            let request = request(&owner, source);
            let id = request.request_id.clone();
            let reply =
                serde_json::to_value(worker.analyze(&service, "main", request).await.unwrap())
                    .unwrap();
            assert_eq!(reply["requestId"], id);
            assert_eq!(reply["method"], "typst-literal-v1");
            if source.starts_with("=") {
                assert_eq!(reply["status"], "ready");
                assert!(reply["literalText"].as_str().unwrap().contains("world"));
            } else {
                assert_eq!(reply["status"], "unavailable");
                assert_eq!(reply["reasonCode"], "incomplete_syntax");
                assert!(reply.get("literalText").is_none());
            }
        }
        assert_eq!(
            std::fs::read(temp.path().join("state/projects.json")).ok(),
            registry
        );
    }

    #[tokio::test]
    async fn malformed_or_retired_owners_and_non_native_windows_cannot_start_analysis() {
        let temp = tempfile::tempdir().unwrap();
        let service = Service::new(temp.path().join("state")).unwrap();
        let owner = service.connect_native_editor("main").unwrap()["ownerId"]
            .as_str()
            .unwrap()
            .to_owned();
        let worker = WordCountWorker::default();
        assert!(
            matches!(worker.analyze(&service, "other", request(&owner, "text")).await, Err(error) if error.code == "forbidden")
        );
        let mut invalid = request(&owner, "text");
        invalid.request_id = "invalid".into();
        assert!(
            matches!(worker.analyze(&service, "main", invalid).await, Err(error) if error.code == "request")
        );
        assert!(
            matches!(worker.analyze(&service, "main", request(&owner, &"x".repeat(MAX_WORD_COUNT_TEXT + 1))).await, Err(error) if error.code == "limit")
        );
        service.connect_native_editor("main").unwrap();
        assert!(
            matches!(worker.analyze(&service, "main", request(&owner, "text")).await, Err(error) if error.code == "stale_session")
        );
        for extra in ["path", "project", "operation", "content"] {
            let mut value = json!({"ownerId":owner,"requestId":uuid::Uuid::new_v4().to_string(),"source":"text"});
            value[extra] = json!("unexpected");
            assert!(serde_json::from_value::<WordCountRequest>(value).is_err());
        }
    }

    #[tokio::test]
    async fn cancelled_waiter_keeps_the_single_worker_permit_until_blocking_work_finishes() {
        let worker = Arc::new(WordCountWorker::default());
        let active = worker.clone();
        let (entered, waiting) = tokio::sync::oneshot::channel();
        let (resume, held) = std::sync::mpsc::channel();
        let caller = tokio::spawn(async move {
            active
                .run(move || {
                    entered.send(()).unwrap();
                    held.recv_timeout(std::time::Duration::from_secs(5))
                        .unwrap();
                    Ok(LiteralText::Ready {
                        literal_text: "finished".into(),
                    })
                })
                .await
        });
        waiting.await.unwrap();
        caller.abort();
        assert!(matches!(caller.await, Err(error) if error.is_cancelled()));
        assert!(matches!(worker.run(|| unreachable!()).await, Err(error) if error.code == "busy"));
        resume.send(()).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                match worker
                    .run(|| {
                        Ok(LiteralText::Ready {
                            literal_text: "next".into(),
                        })
                    })
                    .await
                {
                    Ok(_) => break,
                    Err(error) if error.code == "busy" => {
                        tokio::time::sleep(std::time::Duration::from_millis(10)).await
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        })
        .await
        .unwrap();
    }
}
