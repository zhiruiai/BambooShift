mod agent_delegation_support;
mod workspace_support;
use agent_delegation_support::*;
use openbot_backend::workspace::Table;
use serde_json::json;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::sync::Semaphore;

#[tokio::test]
async fn delegation_keeps_completed_text_and_defers_empty_continuations_until_text() {
    const PREAMBLE: &str = "I am sending the synthetic research task to the specialist.";
    const CHILD: &str = "The specialist returned the synthetic source.";
    const FINAL: &str = "Here is the synthesis of the verified result.";
    let g = Group::new().await;
    let target = g.ids[1].clone();
    let child_entered = Arc::new(Semaphore::new(0));
    let child_release = Arc::new(Semaphore::new(0));
    let final_entered = Arc::new(Semaphore::new(0));
    let final_release = Arc::new(Semaphore::new(0));
    let model = Model::new(Arc::new({
        let (child_entered, child_release) = (child_entered.clone(), child_release.clone());
        let (final_entered, final_release) = (final_entered.clone(), final_release.clone());
        move |body| {
            let target = target.clone();
            let (child_entered, child_release) = (child_entered.clone(), child_release.clone());
            let (final_entered, final_release) = (final_entered.clone(), final_release.clone());
            Box::pin(async move {
                if role(&body) == 1 {
                    child_entered.add_permits(1);
                    wait_gate(&child_release).await;
                    return finish(CHILD);
                }
                let results = body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|message| message["role"] == "tool")
                    .count();
                match results {
                    0 => response(
                        json!({
                            "role":"assistant", "content":PREAMBLE,
                            "tool_calls":[{
                                "index":0, "id":"synthetic-delegate", "type":"function",
                                "function":{"name":"delegate", "arguments":json!({
                                    "agentId":target, "task":"Return one synthetic source."
                                }).to_string()}
                            }]
                        }),
                        "tool_calls",
                    ),
                    1 => {
                        assert!(body.to_string().contains(CHILD));
                        call(
                            "remember",
                            json!({"content":"A synthetic tool-only continuation."}),
                        )
                    }
                    2 => {
                        final_entered.add_permits(1);
                        wait_gate(&final_release).await;
                        finish(FINAL)
                    }
                    _ => panic!("Unexpected synthetic continuation"),
                }
            })
        }
    }))
    .await;
    g.configure(&model).await;
    let input = g
        .send("Coordinate the synthetic research task.", "followUp", false)
        .await;
    wait_gate(&child_entered).await;
    let during_child = g.f.bootstrap().await;
    let is_coordinator = |message: &&serde_json::Value| {
        message["conversationId"] == g.cid
            && message["agentId"] == g.ids[0]
            && message["role"] == "assistant"
    };
    let preamble = during_child["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(is_coordinator)
        .unwrap();
    assert_eq!(preamble["content"], PREAMBLE);
    assert_eq!(preamble["status"], "running");
    let id = preamble["id"].clone();
    let created = preamble["createdAt"].clone();
    child_release.add_permits(1);
    wait_gate(&final_entered).await;
    let during_continuation = g.f.bootstrap().await;
    let visible = during_continuation["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(is_coordinator)
        .collect::<Vec<_>>();
    assert_eq!(
        visible.len(),
        1,
        "Tool-only continuation inserted an empty coordinator row"
    );
    assert_eq!(preamble["metadata"]["streamEnded"], true);
    assert_eq!(visible[0]["id"], id);
    assert_eq!(visible[0]["createdAt"], created);
    assert_eq!(visible[0]["metadata"]["inputMessageId"], input["id"]);
    assert_eq!(visible[0]["metadata"]["streamEnded"], true);
    assert_eq!(visible[0]["status"], "running");
    let chat = during_continuation["conversations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|chat| chat["id"] == g.cid)
        .unwrap();
    assert_eq!(chat["unread"], 0);
    assert_eq!(chat["readThrough"], 0);
    final_release.add_permits(1);
    let done = g.done().await;
    let finished = done.iter().filter(is_coordinator).collect::<Vec<_>>();
    assert_eq!(finished.len(), 2);
    assert_eq!(finished[0]["id"], id);
    assert_eq!(finished[0]["content"], PREAMBLE);
    assert_eq!(finished[1]["content"], FINAL);
    assert!(finished.iter().all(|message| message["status"] == "done"));
    drop(model);
    g.close().await;
}

#[tokio::test]
async fn real_child_uses_profile_memory_and_research_guidance_and_returns_its_result() {
    let g = Group::new().await;
    let target = g.ids[1].clone();
    let model=Model::new(Arc::new(move|body|{let target=target.clone();Box::pin(async move{
        match (role(&body),has_tool_result(&body)) {
            (0,false)=>call("delegate",json!({"agentId":target,"task":"Produce the child result and remember its synthetic preference."})),
            (1,false)=>call("remember",json!({"content":"Only the assigned child owns this synthetic preference","category":"preference"})),
            (1,true)=>finish("Child result: verified synthetic preference saved."),
            (0,true)=>{assert!(body.to_string().contains("Child result: verified"));finish("Parent synthesis of the actual child result.")},
            _=>panic!("Unexpected synthetic model role"),
        }
    })})).await;
    g.configure(&model).await;
    let input = g
        .send(
            "Delegate the synthetic task to the second colleague.",
            "followUp",
            false,
        )
        .await;
    let messages = g.done().await;
    assert_eq!(model.calls.lock().await.len(), 4);
    let child = messages
        .iter()
        .find(|m| m["role"] == "assistant" && m["agentId"] == g.ids[1])
        .unwrap();
    assert_eq!(child["status"], "done");
    assert_eq!(
        child["metadata"]["delegation"]["requesterMessageId"],
        input["id"]
    );
    assert_eq!(messages.iter().filter(|m| m["role"] == "user").count(), 1);
    assert!(
        messages
            .iter()
            .any(|m| m["role"] == "system" && m["metadata"]["delegation"].is_object())
    );
    let memories = g.store.list(Table::Memories).await.unwrap();
    assert_eq!(memories.len(), 1);
    assert_eq!(memories[0]["agentId"], g.ids[1]);
    assert!(
        g.store
            .list(Table::Agents)
            .await
            .unwrap()
            .iter()
            .all(|b| b["status"] == "idle")
    );
    let calls = model.calls.lock().await;
    for index in [0, 1] {
        let request = calls.iter().find(|body| role(body) == index).unwrap();
        let guidance = request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "system")
            .filter_map(|message| message["content"].as_str())
            .collect::<String>();
        assert!(guidance.contains("For latest or current-source research"));
        assert!(guidance.contains("Use web_search first"));
        assert!(guidance.contains("Use web_fetch first"));
        assert!(guidance.contains("Reserve computer_action for actual interactive work"));
        assert!(guidance.contains("latest human correction"));
        assert!(!guidance.contains("assigned, available browser"));
        let tools = request["tools"].as_array().unwrap();
        for name in ["web_search", "web_fetch"] {
            assert!(tools.iter().any(|tool| tool["function"]["name"] == name));
        }
        assert!(guidance.contains("Cite verified source URLs and publication or update dates"));
        assert!(guidance.contains("retrieved evidence from background knowledge"));
        assert!(guidance.contains("explain the specific limit"));
        assert!(!guidance.contains("shared_app_call"));
        assert!(guidance.contains("You work inside BambooShift"));
        assert!(
            guidance.contains("execution engine is separate from the configured language model")
        );
        assert!(!guidance.contains("BambooShift uses Pi Coding Agent"));
    }
    let child_request = calls.iter().find(|v| role(v) == 1).unwrap().to_string();
    assert!(child_request.contains(input["id"].as_str().unwrap()));
    assert!(child_request.contains(&g.f.owner));
    drop(calls);
    drop(model);
    g.close().await;
}

#[tokio::test]
async fn two_levels_execute_but_a_third_level_and_ancestral_cycles_are_rejected() {
    let g = Group::new().await;
    let ids = g.ids.clone();
    let model=Model::new(Arc::new(move|body|{let ids=ids.clone();Box::pin(async move{
        if has_tool_result(&body){return finish("Returned the real nested result or explicit depth rejection.")}
        match role(&body) {
            0=>call("delegate",json!({"agentId":ids[1],"task":"Ask the third colleague for one focused result."})),
            1=>call("delegate",json!({"agentId":ids[2],"task":"Attempt the forbidden deeper delegation; report the actual rejection."})),
            2=>call("delegate",json!({"agentId":ids[3],"task":"This must not start."})),
            _=>panic!("A third-level child was incorrectly started"),
        }
    })})).await;
    g.configure(&model).await;
    g.send("Use at most two child levels.", "followUp", false)
        .await;
    let messages = g.done().await;
    assert_eq!(model.calls.lock().await.len(), 6);
    let children = messages
        .iter()
        .filter(|m| m["role"] == "assistant" && m["metadata"]["delegation"].is_object())
        .collect::<Vec<_>>();
    assert_eq!(children.len(), 2);
    assert!(children.iter().all(|m| m["status"] == "done"));
    assert!(!messages.iter().any(|m| m["agentId"] == g.ids[3]));
    drop(model);
    let root = g.ids[0].clone();
    let target = g.ids[1].clone();
    let cycle=Model::new(Arc::new(move|body|{let(root,target)=(root.clone(),target.clone());Box::pin(async move{
        if has_tool_result(&body){finish("Cycle rejected; no second copy of the ancestor ran.")}
        else {call("delegate",json!({"agentId":if role(&body)==0{target}else{root},"task":"Attempt one delegation."}))}
    })})).await;
    g.configure(&cycle).await;
    g.send("Attempt the synthetic cycle.", "followUp", false)
        .await;
    g.done().await;
    assert_eq!(cycle.calls.lock().await.len(), 4);
    drop(cycle);
    g.close().await;
}

#[tokio::test]
async fn total_children_are_bounded_and_ninth_request_never_starts_another_process() {
    let g = Group::new().await;
    let target = g.ids[1].clone();
    let roots = Arc::new(AtomicUsize::new(0));
    let counter = roots.clone();
    let model = Model::new(Arc::new(move |body| {
        let (target, counter) = (target.clone(), counter.clone());
        Box::pin(async move {
            if role(&body) == 1 {
                return finish("Bounded child result.");
            }
            let n = counter.fetch_add(1, Ordering::SeqCst);
            if n < 9 {
                call(
                    "delegate",
                    json!({"agentId":target,"task":format!("Synthetic focused task {n}")}),
                )
            } else {
                finish("The ninth child was rejected; eight real results were produced.")
            }
        })
    }))
    .await;
    g.configure(&model).await;
    g.send("Check the bounded delegation budget.", "followUp", false)
        .await;
    let messages = g.done().await;
    assert_eq!(roots.load(Ordering::SeqCst), 10);
    assert_eq!(
        model
            .calls
            .lock()
            .await
            .iter()
            .filter(|b| role(b) == 1)
            .count(),
        8
    );
    assert_eq!(
        messages
            .iter()
            .filter(|m| m["role"] == "assistant" && m["agentId"] == g.ids[1])
            .count(),
        8
    );
    drop(model);
    g.close().await;
}
