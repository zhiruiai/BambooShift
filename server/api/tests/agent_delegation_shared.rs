mod agent_delegation_support;
mod shared_bots_support;
mod workspace_support;
use agent_delegation_support::{Model, call, finish, has_tool_result, role, wait_gate};
use openbot_backend::workspace::Table;
use serde_json::json;
use shared_bots_support::{Shared, id};
use std::sync::Arc;
use tokio::sync::Semaphore;

#[tokio::test]
async fn shared_child_uses_recipient_credentials_and_its_grant_still_fences_parent_after_return() {
    let s = Shared::new().await;
    let mut source = s
        .source
        .get(Table::Agents, &s.agent)
        .await
        .unwrap()
        .unwrap();
    source["instructions"] =
        json!("SYNTHETIC_ROLE_1: Perform the assigned child task using its granted tools.");
    source["configRevision"] = json!(id());
    s.source.put(Table::Agents, &source).await.unwrap();
    s.source.put(Table::Skills,&json!({"id":id(),"agentId":s.agent,"name":"Source active method","description":"Synthetic shared method","content":"SOURCE_GRANTED_METHOD","status":"active","version":1,"createdAt":"2026-01-01T00:00:00.000Z"})).await.unwrap();
    s.source
        .put(
            Table::Memories,
            &json!({"id":id(),"agentId":s.agent,"content":"SOURCE_PRIVATE_MEMORY_MUST_NOT_CROSS"}),
        )
        .await
        .unwrap();
    let joined = s.add().await;
    let alias = joined["agentId"].as_str().unwrap().to_owned();
    let prefix = format!("/api/workspaces/{}", s.personal);
    let root=s.f.request("POST",&format!("{prefix}/agents"),Some(json!({"name":"Personal coordinator","instructions":"SYNTHETIC_ROLE_0: Coordinate a focused task."})),true,Some(&s.f.member)).await;
    assert_eq!(root.0, 201, "{}", root.1);
    let aid = root.1["id"].as_str().unwrap().to_owned();
    let chat =
        s.f.request(
            "POST",
            &format!("{prefix}/conversations"),
            Some(json!({"title":"Personal collaboration","agentIds":[aid,alias],"isGroup":true})),
            true,
            Some(&s.f.member),
        )
        .await;
    assert_eq!(chat.0, 201, "{}", chat.1);
    let cid = chat.1["id"].as_str().unwrap().to_owned();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let (ready, gate, target) = (entered.clone(), release.clone(), alias.clone());
    let model=Model::new(Arc::new(move|body|{let(ready,gate,target)=(ready.clone(),gate.clone(),target.clone());Box::pin(async move{
        match (role(&body),has_tool_result(&body)) {
            (0,false)=>call("delegate",json!({"agentId":target,"task":"Remember a recipient-only synthetic preference and return a result."})),
            (1,false)=>{assert!(body.to_string().contains("SOURCE_GRANTED_METHOD"));call("remember",json!({"content":"Recipient-only child preference"}))},
            (1,true)=>finish("Shared child returned its actual result."),
            (0,true)=>{ready.add_permits(1);gate.acquire().await.unwrap().forget();call("remember",json!({"content":"Must not be saved after the child's source grant was revoked"}))},
            _=>panic!("Unexpected role"),
        }
    })})).await;
    assert_eq!(
        s.f.request(
            "PUT",
            &format!("{prefix}/settings"),
            Some(model.config()),
            true,
            Some(&s.f.member)
        )
        .await
        .0,
        200
    );
    let mut source_config = model.config();
    source_config["apiKey"] = json!("SYNTHETIC_SOURCE_CREDENTIAL_NEVER_INHERITED");
    assert_eq!(
        s.f.request(
            "PUT",
            &s.f.path("/settings"),
            Some(source_config),
            false,
            Some(&s.f.owner)
        )
        .await
        .0,
        200
    );
    let accepted=s.f.request("POST",&format!("{prefix}/conversations/{cid}/messages"),Some(json!({"clientId":id(),"agentId":aid,"content":"Use the shared colleague once.","mode":"followUp"})),true,Some(&s.f.member)).await;
    assert_eq!(accepted.0, 202, "{}", accepted.1);
    wait_gate(&entered).await;
    let target_store =
        s.f.state
            .workspace
            .get(&s.personal, &s.personal)
            .await
            .unwrap();
    let before = target_store.list(Table::Messages).await.unwrap();
    assert!(
        before
            .iter()
            .any(|m| m["agentId"] == alias && m["role"] == "assistant" && m["status"] == "done")
    );
    let revoked =
        s.f.request(
            "POST",
            &format!("{}/revoke", s.sharing()),
            Some(json!({"requestId":id(),"expectedRevision":s.share["revision"]})),
            false,
            Some(&s.f.owner),
        )
        .await;
    assert_eq!(revoked.0, 200, "{}", revoked.1);
    tokio::time::timeout(std::time::Duration::from_secs(20), async {
        loop {
            if s.f.state.agent_runs.requests(&s.personal).await.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("The parent retained no source-grant watchdog after its child returned");
    release.add_permits(1);
    let messages = target_store.list(Table::Messages).await.unwrap();
    assert!(
        messages
            .iter()
            .any(|m| m["agentId"] == aid && m["role"] == "assistant" && m["status"] == "error")
    );
    let memories = target_store.list(Table::Memories).await.unwrap();
    assert_eq!(memories.len(), 1);
    assert_eq!(memories[0]["agentId"], alias);
    assert_eq!(s.source.list(Table::Memories).await.unwrap().len(), 1);
    assert!(
        !json!(*model.calls.lock().await)
            .to_string()
            .contains("SOURCE_PRIVATE_MEMORY_MUST_NOT_CROSS")
    );
    assert!(
        model
            .authorization
            .lock()
            .await
            .iter()
            .all(|v| v == "Bearer SYNTHETIC_DELEGATION_KEY")
    );
    drop(model);
    s.close().await;
}

#[tokio::test]
async fn source_definition_and_recipient_model_are_frozen_per_root_then_updated_for_the_next_root()
{
    use std::sync::atomic::{AtomicUsize, Ordering};
    let s = Shared::new().await;
    let mut source = s
        .source
        .get(Table::Agents, &s.agent)
        .await
        .unwrap()
        .unwrap();
    source["instructions"] = json!("SYNTHETIC_ROLE_1 SOURCE_PROFILE_OLD");
    source["configRevision"] = json!(id());
    s.source.put(Table::Agents, &source).await.unwrap();
    let mut skill = json!({"id":id(),"agentId":s.agent,"name":"Snapshot skill","description":"Synthetic","content":"SOURCE_SKILL_OLD","status":"active","version":1,"createdAt":"2026-01-01T00:00:00.000Z"});
    s.source.put(Table::Skills, &skill).await.unwrap();
    let alias = s.add().await["agentId"].as_str().unwrap().to_owned();
    let prefix = format!("/api/workspaces/{}", s.personal);
    let root =
        s.f.request(
            "POST",
            &format!("{prefix}/agents"),
            Some(json!({"name":"Snapshot coordinator","instructions":"SYNTHETIC_ROLE_0"})),
            true,
            Some(&s.f.member),
        )
        .await
        .1;
    let chat =
        s.f.request(
            "POST",
            &format!("{prefix}/conversations"),
            Some(json!({"title":"Snapshot group","agentIds":[root["id"],alias],"isGroup":true})),
            true,
            Some(&s.f.member),
        )
        .await
        .1;
    let cid = chat["id"].as_str().unwrap().to_owned();
    let entered = Arc::new(Semaphore::new(0));
    let release = Arc::new(Semaphore::new(0));
    let count = Arc::new(AtomicUsize::new(0));
    let (ready, gate, steps, target) = (
        entered.clone(),
        release.clone(),
        count.clone(),
        alias.clone(),
    );
    let model=Model::new(Arc::new(move|body|{let(ready,gate,steps,target)=(ready.clone(),gate.clone(),steps.clone(),target.clone());Box::pin(async move{
        if role(&body)==1{return finish("A real child completed with its captured definition.")}
        match steps.fetch_add(1,Ordering::SeqCst) {
            0|3=>call("delegate",json!({"agentId":target,"task":"First focused child for this root."})),
            1=>{ready.add_permits(1);gate.acquire().await.unwrap().forget();call("delegate",json!({"agentId":target,"task":"Second child must retain this root's first definition."}))},
            _=>finish("Finished the root with real child results."),
        }
    })})).await;
    assert_eq!(
        s.f.request(
            "PUT",
            &format!("{prefix}/settings"),
            Some(model.config()),
            true,
            Some(&s.f.member)
        )
        .await
        .0,
        200
    );
    let send =
        |text: &str| json!({"content":text,"clientId":id(),"agentId":root["id"],"mode":"followUp"});
    assert_eq!(
        s.f.request(
            "POST",
            &format!("{prefix}/conversations/{cid}/messages"),
            Some(send("First root: use the colleague twice.")),
            true,
            Some(&s.f.member)
        )
        .await
        .0,
        202
    );
    wait_gate(&entered).await;
    source["instructions"] = json!("SYNTHETIC_ROLE_1 SOURCE_PROFILE_NEW");
    source["configRevision"] = json!(id());
    s.source.put(Table::Agents, &source).await.unwrap();
    skill["content"] = json!("SOURCE_SKILL_NEW");
    skill["version"] = json!(2);
    s.source.put(Table::Skills, &skill).await.unwrap();
    let mut configuration = model.config();
    configuration["apiKey"] = json!("SYNTHETIC_NEW_RECIPIENT_KEY");
    assert_eq!(
        s.f.request(
            "PUT",
            &format!("{prefix}/settings"),
            Some(configuration.clone()),
            true,
            Some(&s.f.member)
        )
        .await
        .0,
        409
    );
    release.add_permits(1);
    wait_personal(&s).await;
    assert_eq!(
        s.f.request(
            "PUT",
            &format!("{prefix}/settings"),
            Some(configuration),
            true,
            Some(&s.f.member)
        )
        .await
        .0,
        200
    );
    assert_eq!(
        s.f.request(
            "POST",
            &format!("{prefix}/conversations/{cid}/messages"),
            Some(send("Second root: use the colleague once.")),
            true,
            Some(&s.f.member)
        )
        .await
        .0,
        202
    );
    wait_personal(&s).await;
    let records = model.calls.lock().await;
    let child = records
        .iter()
        .filter(|b| role(b) == 1)
        .map(|b| {
            b["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "system")
                .map(|m| m["content"].as_str().unwrap_or(""))
                .collect::<String>()
        })
        .collect::<Vec<_>>();
    assert_eq!(child.len(), 3);
    assert!(
        child[..2]
            .iter()
            .all(|text| text.contains("SOURCE_PROFILE_OLD")
                && text.contains("SOURCE_SKILL_OLD")
                && !text.contains("SOURCE_PROFILE_NEW"))
    );
    assert!(child[2].contains("SOURCE_PROFILE_NEW") && child[2].contains("SOURCE_SKILL_NEW"));
    drop(records);
    let auth = model.authorization.lock().await;
    assert_eq!(auth.len(), 8);
    assert!(
        auth[..5]
            .iter()
            .all(|a| a == "Bearer SYNTHETIC_DELEGATION_KEY")
    );
    assert!(
        auth[5..]
            .iter()
            .all(|a| a == "Bearer SYNTHETIC_NEW_RECIPIENT_KEY")
    );
    drop(auth);
    drop(model);
    s.close().await;
}
async fn wait_personal(s: &Shared) {
    tokio::time::timeout(std::time::Duration::from_secs(25), async {
        loop {
            if s.f.state.agent_runs.requests(&s.personal).await.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}
