mod agent_delegation_support;
mod app_policy_support;
mod apps_support;
mod workspace_support;
use app_policy_support::*;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

#[tokio::test]
async fn real_scheduled_pi_reads_once_without_human_approval_and_keeps_policy_audit() {
    let (g, s, c, r) = setup().await;
    let policy = grant(&g, &c, &r).await;
    let m = Model::new(model(&c, "read_notes", json!({"query":"newer_than:1d"}))).await;
    g.configure(&m).await;
    sqlx::query("DELETE FROM account_sessions WHERE user_id=?")
        .bind(&g.f.owner)
        .execute(&g.f.db)
        .await
        .unwrap();
    schedule(&g, &r).await;
    g.done().await;
    let a = action(&g, "done").await;
    assert_eq!(a["policy"]["policyId"], policy["id"]);
    assert_eq!(a["policy"]["issuerUserId"], g.f.owner);
    assert_eq!(a["policy"]["routineId"], r["id"]);
    assert!(a["result"]["text"].as_str().unwrap().contains("done"));
    assert_eq!(s.remote.calls.load(Ordering::SeqCst), 1);
    assert_eq!(m.calls.lock().await.len(), 2);
    drop(m);
    drop(s);
    g.close().await;
}
#[tokio::test]
async fn manual_messages_manual_runs_changed_parameters_and_write_tools_still_require_approval() {
    for mode in ["human", "member", "manual", "arguments", "write"] {
        let (g, s, c, r) = setup().await;
        grant(&g, &c, &r).await;
        let args = if mode == "arguments" {
            json!({"query":"all notes"})
        } else {
            json!({"query":"newer_than:1d"})
        };
        let m = Model::new(model(
            &c,
            if mode == "write" {
                "write_note"
            } else {
                "read_notes"
            },
            args,
        ))
        .await;
        g.configure(&m).await;
        match mode {
            "human" | "member" => {
                g.send("Read the notes.", "followUp", mode == "member")
                    .await;
            }
            "manual" => {
                assert_eq!(
                    g.f.request(
                        "POST",
                        &g.f.path(&format!("/routines/{}/run", r["id"].as_str().unwrap())),
                        None,
                        false,
                        Some(&g.f.owner)
                    )
                    .await
                    .0,
                    202
                );
            }
            _ => schedule(&g, &r).await,
        }
        let a = action(&g, "pending").await;
        assert!(a.get("policy").is_none(), "{mode}");
        assert_eq!(s.remote.calls.load(Ordering::SeqCst), 0, "{mode}");
        let stop =
            g.f.request(
                "POST",
                &g.f.path(&format!(
                    "/app-actions/{}/decision",
                    a["id"].as_str().unwrap()
                )),
                Some(json!({"approve":false})),
                mode == "member",
                Some(if mode == "member" {
                    &g.f.member
                } else {
                    &g.f.owner
                }),
            )
            .await;
        assert_eq!(stop.0, 200, "{}", stop.1);
        g.done().await;
        drop(m);
        drop(s);
        g.close().await;
    }
}
#[tokio::test]
async fn revocation_during_the_actual_call_rejects_late_result_and_repeated_tool_uses_original_unknown_receipt()
 {
    let (g, s, c, r) = setup().await;
    let policy = grant(&g, &c, &r).await;
    s.remote.hold.store(true, Ordering::SeqCst);
    let id = c["id"].clone();
    let n = Arc::new(AtomicUsize::new(0));
    let m=Model::new(Arc::new(move|_|{let(id,n)=(id.clone(),n.clone());Box::pin(async move{if n.fetch_add(1,Ordering::SeqCst)<2{call("app_call",json!({"connectionId":id,"toolName":"read_notes","arguments":{"query":"newer_than:1d"}}))}else{finish("Only the original unknown receipt is available.")}})})).await;
    g.configure(&m).await;
    schedule(&g, &r).await;
    apps_support::wait_until(|| s.remote.calls.load(Ordering::SeqCst) == 1).await;
    let revoke = format!("{}/{}/revoke", path(&g, &c), policy["id"].as_str().unwrap());
    assert_eq!(
        g.f.request("POST", &revoke, Some(json!({})), false, Some(&g.f.owner))
            .await
            .0,
        200
    );
    s.remote.hold.store(false, Ordering::SeqCst);
    g.done().await;
    let a = action(&g, "error").await;
    assert!(a.get("result").is_none());
    assert_eq!(s.remote.calls.load(Ordering::SeqCst), 1);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_policy_uses")
        .fetch_one(&g.store.pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
    drop(m);
    drop(s);
    g.close().await;
}
