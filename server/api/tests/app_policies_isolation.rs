mod agent_delegation_support;
mod app_policy_support;
mod apps_support;
mod workspace_support;
use app_policy_support::*;
use openbot_backend::{apps, config::Config, db::State};
use serde_json::json;
use std::sync::{Arc, atomic::Ordering};

#[tokio::test]
async fn a_new_workspace_owner_cannot_borrow_the_previous_owners_background_grant() {
    let (g, s, c, r) = setup().await;
    grant(&g, &c, &r).await;
    let m = Model::new(model(&c, "read_notes", json!({"query":"newer_than:1d"}))).await;
    g.configure(&m).await;
    let mut tx = g.f.db.begin().await.unwrap();
    sqlx::query("UPDATE memberships SET role='member' WHERE workspace_id=? AND user_id=?")
        .bind(&g.f.workspace)
        .bind(&g.f.owner)
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE memberships SET role='owner' WHERE workspace_id=? AND user_id=?")
        .bind(&g.f.workspace)
        .bind(&g.f.member)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    schedule(&g, &r).await;
    let pending = action(&g, "pending").await;
    assert!(pending.get("policy").is_none());
    assert_eq!(s.remote.calls.load(Ordering::SeqCst), 0);
    let response =
        g.f.request(
            "POST",
            &g.f.path(&format!(
                "/app-actions/{}/decision",
                pending["id"].as_str().unwrap()
            )),
            Some(json!({"approve":false})),
            true,
            Some(&g.f.member),
        )
        .await;
    assert_eq!(response.0, 200, "{}", response.1);
    g.done().await;
    assert_eq!(
        g.f.request("GET", &path(&g, &c), None, false, Some(&g.f.owner))
            .await
            .0,
        403
    );
    drop(m);
    drop(s);
    g.close().await;
}

#[tokio::test]
async fn a_dispatched_unknown_call_keeps_its_receipt_on_restart_and_is_never_automatically_replayed()
 {
    let (mut g, s, c, r) = setup().await;
    let policy = grant(&g, &c, &r).await;
    let m = Model::new(model(&c, "read_notes", json!({"query":"newer_than:1d"}))).await;
    g.configure(&m).await;
    s.remote.hold.store(true, Ordering::SeqCst);
    schedule(&g, &r).await;
    apps_support::wait_until(|| s.remote.calls.load(Ordering::SeqCst) == 1).await;
    let running = action(&g, "running").await;
    tokio::time::timeout(std::time::Duration::from_secs(10), g.f.state.close())
        .await
        .expect("Actual application worker must drain during close");
    s.remote.hold.store(false, Ordering::SeqCst);
    g.f.state = State::open(Config::local(g.f.directory.path()))
        .await
        .unwrap();
    g.f.state.apps = Arc::new(apps::AppsRuntime::fixture(vec![s.remote.origin.clone()]).unwrap());
    g.store =
        g.f.state
            .workspace
            .get(&g.f.workspace, &g.f.workspace)
            .await
            .unwrap();
    let recovered = apps::actions::get(&g.store, running["id"].as_str().unwrap())
        .await
        .unwrap();
    assert!(matches!(
        recovered["status"].as_str(),
        Some("error" | "cancelled")
    ));
    assert_eq!(recovered["policy"]["policyId"], policy["id"]);
    assert!(recovered.get("result").is_none());
    let original: String = sqlx::query_scalar("SELECT action_id FROM app_policy_uses")
        .fetch_one(&g.store.pool)
        .await
        .unwrap();
    assert_eq!(original, running["id"].as_str().unwrap());
    g.f.bootstrap().await;
    openbot_backend::scheduling::tick(&g.f.state, chrono::Utc::now().timestamp_millis())
        .await
        .unwrap();
    assert_eq!(s.remote.calls.load(Ordering::SeqCst), 1);
    assert!(
        g.f.state
            .agent_runs
            .requests(&g.f.workspace)
            .await
            .is_empty()
    );
    drop(m);
    drop(s);
    g.close().await;
}
