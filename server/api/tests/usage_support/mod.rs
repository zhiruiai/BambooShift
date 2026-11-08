#![allow(dead_code)]
pub use crate::workspace_support::Fixture;
use serde_json::{Value, json};
use std::time::Duration;

pub async fn usage(f: &Fixture, member: bool, days: u16) -> Value {
    let actor = if member { &f.member } else { &f.owner };
    let (status, value) = f
        .request(
            "GET",
            &f.path(&format!("/usage?days={days}")),
            None,
            member,
            Some(actor),
        )
        .await;
    assert_eq!(status, 200, "{value}");
    value
}
pub async fn submit(f: &Fixture, member: bool, mode: &str) -> Value {
    let before = f.bootstrap().await;
    let cid = before["conversations"][0]["id"].as_str().unwrap();
    let actor = if member { &f.member } else { &f.owner };
    let (status,value)=f.request("POST",&f.path(&format!("/conversations/{cid}/messages")),Some(json!({"content":"Synthetic usage task","clientId":uuid::Uuid::new_v4().to_string(),"mode":mode})),member,Some(actor)).await;
    assert_eq!(status, 202, "{value}");
    value
}
pub async fn done(f: &Fixture) {
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let b = f.bootstrap().await;
            if b["runningRequests"] == json!([])
                && b["messages"].as_array().unwrap().iter().any(|m| {
                    m["role"] == "assistant"
                        && ["done", "error"].contains(&m["status"].as_str().unwrap_or(""))
                })
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}
pub async fn fake_worker(f: &mut Fixture, mode: &str) -> std::path::PathBuf {
    let runtime = f.directory.path().join("fake-runtime");
    let package = runtime.join("packages/pi-worker");
    std::fs::create_dir_all(&package).unwrap();
    let script=r#"
import {createInterface} from 'node:readline';import {writeFileSync,writeSync} from 'node:fs';
let run;const mode=MODE;const send=(event)=>writeSync(1,JSON.stringify({version:1,runId:run.runId,...event})+'\n');
const event=(type,usage,content=[])=>send({type:'event',event:{type,message:{role:'assistant',content,...(usage?{usage}:{})}}});
const counts=mode==='zero'?{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{total:0}}:{input:13,output:7,cacheRead:5,cacheWrite:3,totalTokens:28,cost:{total:0}};
function finish(){event('message_start');event('message_end',counts);event('message_end',counts);event('message_start');event('message_end',undefined,[{type:'text',text:'Synthetic final response'}]);send({type:'settled',status:'completed'});process.stdin.destroy();}
createInterface({input:process.stdin}).on('line',line=>{const value=JSON.parse(line);if(value.type==='start'){run=value;send({type:'started'});writeFileSync('entered','ready');if(mode==='normal'||mode==='zero')finish();else if(mode==='held')setTimeout(finish,1200);else event('message_start');}else if(value.type==='steer'){event('message_end',counts);send({type:'input_delivered',inputId:value.inputId});event('message_start');event('message_end',{input:3,output:2,cacheRead:0,cacheWrite:0,totalTokens:5},[{type:'text',text:'Fresh generation'}]);send({type:'settled',status:'completed'});process.stdin.destroy();}});
"#.replace("MODE",&serde_json::to_string(mode).unwrap());
    std::fs::write(package.join("index.mjs"), script).unwrap();
    std::sync::Arc::make_mut(&mut f.state.config).runtime_dir = runtime.clone();
    let response=f.request("PUT",&f.path("/settings"),Some(json!({"provider":"synthetic-ledger","model":"fixture","baseUrl":"http://127.0.0.1:9/v1","apiKey":"SYNTHETIC_USAGE_KEY"})),false,Some(&f.owner)).await;
    assert_eq!(response.0, 200, "{}", response.1);
    runtime
}
pub async fn entered(path: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(15), async {
        while !path.join("entered").exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
}
