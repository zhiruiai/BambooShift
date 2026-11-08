mod agent_delegation_support;
mod workspace_support;
use agent_delegation_support::*;
use openbot_backend::workspace::Table;
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

fn last_tool(body: &Value) -> Value {
    let message = body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .unwrap();
    serde_json::from_str(message["content"].as_str().unwrap())
        .expect("The actual tool response must be structured JSON")
}

#[tokio::test]
async fn owner_chat_performs_the_actual_five_tool_lifecycle_without_executing_the_saved_prompt() {
    let g = Group::new().await;
    let step = Arc::new(AtomicUsize::new(0));
    let counter = step.clone();
    let model=Model::new(Arc::new(move|body|{let counter=counter.clone();Box::pin(async move{
        let n=counter.fetch_add(1,Ordering::SeqCst);
        if n==0 {return call("routine_create",json!({"title":"Synthetic plan","prompt":"Never execute this scheduled prompt during creation","schedule":"weekly:1,3,5:09:30","timeZone":"Asia/Shanghai"}))}
        let value=last_tool(&body);
        match n {
            1=>{assert_eq!(value["status"],"created");call("routine_update",json!({"routineId":value["routineId"],"expectedRevision":value["routine"]["revision"],"changes":{"schedule":"weekly:1,3,5:10:15","prompt":"Updated synthetic future task"}}))},
            2=>{assert_eq!(value["status"],"updated");call("routine_pause",json!({"routineId":value["routineId"],"expectedRevision":value["routine"]["revision"],"paused":true}))},
            3=>{assert_eq!(value["status"],"paused");call("routine_pause",json!({"routineId":value["routineId"],"expectedRevision":value["routine"]["revision"],"paused":false}))},
            4=>{assert_eq!(value["status"],"resumed");call("routine_delete",json!({"routineId":value["routineId"],"expectedRevision":value["routine"]["revision"]}))},
            5=>{assert_eq!(value["status"],"deleted");call("routine_list",json!({}))},
            6=>{assert_eq!(value["total"],0);finish("The actual routine was created, updated, paused, resumed and deleted; no scheduled task ran.")},
            _=>panic!("Unexpected additional model request"),
        }
    })})).await;
    g.configure(&model).await;
    g.send(
        "Manage the synthetic future plan, without executing its work.",
        "followUp",
        false,
    )
    .await;
    let messages = g.done().await;
    assert_eq!(step.load(Ordering::SeqCst), 7);
    assert!(g.store.list(Table::Routines).await.unwrap().is_empty());
    assert_eq!(messages.iter().filter(|m| m["role"] == "user").count(), 1);
    let receipts: i64 = sqlx::query_scalar("SELECT count(*) FROM routine_tool_operations")
        .fetch_one(&g.store.pool)
        .await
        .unwrap();
    assert_eq!(receipts, 5);
    drop(model);
    g.close().await;
}

#[tokio::test]
async fn repeated_exact_tool_call_is_durable_and_a_stale_configuration_is_rejected() {
    let g = Group::new().await;
    let step = Arc::new(AtomicUsize::new(0));
    let counter = step.clone();
    let store = g.store.clone();
    let model=Model::new(Arc::new(move|body|{let(counter,store)=(counter.clone(),store.clone());Box::pin(async move{
        let n=counter.fetch_add(1,Ordering::SeqCst);
        if n<2 {
            return response(json!({"role":"assistant","tool_calls":[{"index":0,"id":"same-persistent-call","type":"function","function":{"name":"routine_create","arguments":json!({"title":"Only one plan","prompt":"Synthetic future task","schedule":"daily:09:30"}).to_string()}}]}),"tool_calls")
        }
        if n==2 {
            let value=last_tool(&body);
            let mut saved=store.get(Table::Routines,value["routineId"].as_str().unwrap()).await.unwrap().unwrap();
            saved["title"]=json!("Changed in another window");
            store.put(Table::Routines,&saved).await.unwrap();
            return call("routine_update",json!({"routineId":value["routineId"],"expectedRevision":value["routine"]["revision"],"changes":{"title":"Stale overwrite"}}));
        }
        assert_eq!(n,3);
        assert!(body.to_string().contains("例行任务已变化"));
        finish("The duplicate request was not repeated and the stale update was rejected.")
    })})).await;
    g.configure(&model).await;
    g.send("Create only one synthetic future plan.", "followUp", false)
        .await;
    g.done().await;
    let routines = g.store.list(Table::Routines).await.unwrap();
    assert_eq!(routines.len(), 1);
    assert_eq!(routines[0]["title"], "Changed in another window");
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM routine_tool_operations")
            .fetch_one(&g.store.pool)
            .await
            .unwrap(),
        1
    );
    drop(model);
    g.close().await;
}

#[tokio::test]
async fn member_and_delegated_child_cannot_gain_owner_plan_management() {
    let g = Group::new().await;
    let target = g.ids[1].clone();
    let model=Model::new(Arc::new(move|body|{let target=target.clone();Box::pin(async move{
        if has_tool_result(&body) {return finish("Used only the authority actually granted.")}
        if role(&body)==0 {call("delegate",json!({"agentId":target,"task":"Try a routine creation that must be refused for a child."}))}
        else {call("routine_create",json!({"title":"Forbidden child plan","prompt":"Never saved","schedule":"daily:09:00"}))}
    })})).await;
    g.configure(&model).await;
    g.send(
        "Delegate one synthetic authorization check.",
        "followUp",
        false,
    )
    .await;
    g.done().await;
    assert!(g.store.list(Table::Routines).await.unwrap().is_empty());
    drop(model);
    let member=Model::new(Arc::new(move|body|Box::pin(async move{
        if has_tool_result(&body) {finish("Member request did not create a routine.")}
        else {call("routine_create",json!({"title":"Forbidden member plan","prompt":"Never saved","schedule":"daily:09:00"}))}
    }))).await;
    g.configure(&member).await;
    g.send("Check member authority.", "followUp", true).await;
    g.done().await;
    assert!(g.store.list(Table::Routines).await.unwrap().is_empty());
    drop(member);
    g.close().await;
}
