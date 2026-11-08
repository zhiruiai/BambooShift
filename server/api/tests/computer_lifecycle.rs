mod computer_support;
mod workspace_support;
use computer_support::*;
use serde_json::json;
use std::sync::atomic::Ordering;
use workspace_support::Fixture;

#[tokio::test]
async fn readonly_inventory_never_allocates_and_two_slots_release_explicitly_with_replay_receipt() {
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    connect(&f, &s.worker).await;
    let data = seeded(&f).await;
    let a = data["agents"][0]["id"].as_str().unwrap();
    let b = data["agents"][1]["id"].as_str().unwrap();
    let (_, before) = f
        .request(
            "GET",
            &f.path("/computer/bots"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(before["capacity"]["assigned"], 0);
    let first = prepared(&f, a).await;
    let second = prepared(&f, b).await;
    assert_ne!(
        first["botScreen"]["screenId"],
        second["botScreen"]["screenId"]
    );
    assert_eq!(
        f.request(
            "POST",
            &f.path("/computer/disconnect"),
            Some(json!({})),
            false,
            Some(&f.owner)
        )
        .await
        .0,
        409
    );
    let body =
        json!({"confirm":true,"assignmentRevision":first["botScreen"]["assignmentRevision"]});
    let endpoint = f.path(&format!("/computer/bots/{a}/release"));
    assert_eq!(
        f.request("POST", &endpoint, Some(body.clone()), true, Some(&f.member))
            .await
            .0,
        403
    );
    let (status, released) = f
        .request("POST", &endpoint, Some(body.clone()), false, Some(&f.owner))
        .await;
    assert_eq!(status, 200, "{released}");
    assert_eq!(released["botScreen"]["status"], "unassigned");
    let assigned_again = prepared(&f, a).await;
    assert_ne!(
        assigned_again["botScreen"]["assignmentRevision"],
        first["botScreen"]["assignmentRevision"]
    );
    let (_, replay) = f
        .request("POST", &endpoint, Some(body), false, Some(&f.owner))
        .await;
    assert_eq!(
        replay["botScreen"]["assignmentRevision"],
        assigned_again["botScreen"]["assignmentRevision"]
    );
    assert_eq!(s.worker.lifecycle_count.load(Ordering::SeqCst), 1);
    f.state.close().await;
}
#[tokio::test]
async fn lost_lifecycle_reply_is_resumed_as_same_persisted_operation_not_new_release() {
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    connect(&f, &s.worker).await;
    let data = seeded(&f).await;
    let agent = data["agents"][0]["id"].as_str().unwrap();
    let prepared = prepared(&f, agent).await;
    s.worker.lose_lifecycle.store(true, Ordering::SeqCst);
    let base = f.path(&format!("/computer/bots/{agent}"));
    let body =
        json!({"confirm":true,"assignmentRevision":prepared["botScreen"]["assignmentRevision"]});
    let (status, unknown) = f
        .request(
            "POST",
            &format!("{base}/release"),
            Some(body.clone()),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{unknown}");
    assert_eq!(unknown["botScreen"]["lifecycle"]["state"], "blocked");
    let (_, read) = f
        .request(
            "GET",
            &format!("{base}/status"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(
        read["botScreen"]["lifecycle"]["operation"],
        unknown["botScreen"]["lifecycle"]["operation"]
    );
    assert_eq!(s.worker.lifecycle_count.load(Ordering::SeqCst), 1);
    let resume = json!({"confirm":true,"assignmentRevision":body["assignmentRevision"],"operationId":unknown["botScreen"]["lifecycle"]["operation"]["id"]});
    let (status, done) = f
        .request(
            "POST",
            &format!("{base}/lifecycle/resume"),
            Some(resume),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["botScreen"]["status"], "unassigned");
    assert_eq!(s.worker.lifecycle_count.load(Ordering::SeqCst), 1);
    f.state.close().await;
}
#[tokio::test]
async fn unknown_cleanup_requires_reset_rotates_generation_and_keeps_other_screen() {
    let f = Fixture::new().await;
    let s = Server::start(&f.workspace).await;
    connect(&f, &s.worker).await;
    let data = seeded(&f).await;
    let agent = data["agents"][0]["id"].as_str().unwrap();
    let other = data["agents"][1]["id"].as_str().unwrap();
    let first = prepared(&f, agent).await;
    let second = prepared(&f, other).await;
    s.worker.cleanup_ok.store(false, Ordering::SeqCst);
    let base = f.path(&format!("/computer/bots/{agent}"));
    let (status, action) = f
        .request(
            "POST",
            &format!("{base}/actions"),
            Some(json!({"type":"terminal_command","command":"pwd"})),
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(status, 200, "{action}");
    assert_eq!(action["status"], "error");
    s.worker.cleanup_ok.store(true, Ordering::SeqCst);
    let (_, current) = f
        .request(
            "GET",
            &format!("{base}/status"),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(
        current["botScreen"]["lifecycle"]["resetAllowed"], true,
        "{current}"
    );
    let (status,reset)=f.request("POST",&format!("{base}/reset"),Some(json!({"confirm":true,"assignmentRevision":first["botScreen"]["assignmentRevision"]})),false,Some(&f.owner)).await;
    assert_eq!(status, 200, "{reset}");
    assert_eq!(reset["botScreen"]["status"], "ready");
    assert_ne!(
        reset["botScreen"]["assignmentRevision"],
        first["botScreen"]["assignmentRevision"]
    );
    assert_ne!(
        reset["desktop"]["session"]["generation"],
        first["desktop"]["session"]["generation"]
    );
    let (_, still) = f
        .request(
            "GET",
            &f.path(&format!("/computer/bots/{other}/status")),
            None,
            false,
            Some(&f.owner),
        )
        .await;
    assert_eq!(
        still["botScreen"]["assignmentRevision"],
        second["botScreen"]["assignmentRevision"]
    );
    assert_eq!(still["desktop"]["session"], second["desktop"]["session"]);
    f.state.close().await;
}
