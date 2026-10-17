use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publication_waits_for_the_document_barrier_without_relaxing_other_guards() {
    let temporary = tempfile::tempdir().unwrap();
    let service = Service::new(temporary.path().join("state")).unwrap();
    let held = service.documents.lock().await;
    assert_eq!(
        service.source_effect_guard(None).err().unwrap().code,
        "busy"
    );
    let waiting_service = service.clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let waiting = tokio::task::spawn_blocking(move || {
        started.send(()).unwrap();
        waiting_service
            .publication_source_effect_guard(None)
            .is_ok()
    });
    ready.await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(
        !waiting.is_finished(),
        "Publication must wait without discarding its work"
    );
    drop(held);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(3), waiting)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(
        service.documents.try_lock().is_ok(),
        "The completed stage releases the barrier"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn owner_can_be_retired_while_publication_waits_and_is_rechecked_afterward() {
    let temporary = tempfile::tempdir().unwrap();
    let service = Service::new(temporary.path().join("state")).unwrap();
    let owner = service.connect_native_editor("main").unwrap()["ownerId"]
        .as_str()
        .unwrap()
        .to_owned();
    let held = service.documents.lock().await;
    let waiting_service = service.clone();
    let (started, ready) = tokio::sync::oneshot::channel();
    let result = tokio::task::spawn_blocking(move || {
        started.send(()).unwrap();
        waiting_service
            .publication_source_effect_guard(Some(&("main".into(), owner)))
            .err()
            .unwrap()
            .code
    });
    ready.await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert!(!result.is_finished());
    let retiring_service = service.clone();
    let retired =
        tokio::task::spawn_blocking(move || retiring_service.connect_native_editor("main"));
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(3), retired)
            .await
            .unwrap()
            .unwrap()
            .is_ok(),
        "Owner retirement must remain live while publication waits"
    );
    drop(held);
    let code = tokio::time::timeout(std::time::Duration::from_secs(3), result)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(code, "stale_session");
}
