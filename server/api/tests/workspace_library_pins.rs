mod workspace_support;

use openbot_backend::workspace::{Table, WorkspaceStore};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use workspace_support::Fixture;

const CHAT: &str = "fixture-library-chat";
const OTHER_CHAT: &str = "fixture-other-chat";

async fn setup(f: &Fixture) -> Arc<WorkspaceStore> {
    let bootstrap = f.bootstrap().await;
    let store = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    for id in [CHAT, OTHER_CHAT] {
        store
            .put(
                Table::Conversations,
                &json!({"id":id,"title":id,"agentIds":[bootstrap["agents"][0]["id"]]}),
            )
            .await
            .unwrap();
    }
    store
}

fn path(f: &Fixture, conversation: &str) -> String {
    f.path(&format!("/conversations/{conversation}/library/pins"))
}

async fn pins(f: &Fixture, member: bool) -> Value {
    let (status, body) = f
        .request(
            "GET",
            &path(f, CHAT),
            None,
            member,
            Some(if member { &f.member } else { &f.owner }),
        )
        .await;
    assert_eq!(status, 200, "{body}");
    body
}

async fn update(f: &Fixture, member: bool, body: Value) -> (u16, Value) {
    f.request(
        "PUT",
        &path(f, CHAT),
        Some(body),
        member,
        Some(if member { &f.member } else { &f.owner }),
    )
    .await
}

async fn website(store: &WorkspaceStore, cid: &str, message: &str, version: &str, project: &str) {
    let summary = json!({"id":version,"projectKey":project,"title":"Fixture website","entry":"index.html","fileCount":1,"totalBytes":20});
    sqlx::query("INSERT INTO website_projects VALUES(?,?)")
        .bind(version)
        .bind(summary.to_string())
        .execute(&store.pool)
        .await
        .unwrap();
    store.put(Table::Messages, &json!({"id":message,"conversationId":cid,"role":"assistant","kind":"website_project","content":"Fixture site","metadata":{"websiteProject":summary}})).await.unwrap();
}

#[tokio::test]
async fn viewer_pins_survive_republishing_and_concurrent_retries_without_leaking() {
    let f = Fixture::new().await;
    let store = setup(&f).await;
    let key = "a".repeat(64);
    website(&store, CHAT, "site-original", &"b".repeat(64), &key).await;
    let mut events = store.subscribe();
    let website_pin = json!({"kind":"website","target":key,"pinned":true});
    let (status, owner) = update(&f, false, website_pin.clone()).await;
    assert_eq!(status, 200, "{owner}");
    assert_eq!(owner["pins"][0]["target"], key);
    assert_eq!(owner["pins"][0]["kind"], "website");
    assert!(
        owner["pins"][0]["pinnedAt"]
            .as_str()
            .unwrap()
            .ends_with('Z')
    );
    let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.event, "update");
    assert_eq!(event.data, json!({}));
    assert_eq!(pins(&f, true).await, json!({"pins":[]}));
    assert_eq!(update(&f, true, website_pin.clone()).await.0, 200);

    website(&store, CHAT, "site-latest", &"c".repeat(64), &key).await;
    store
        .delete(Table::Messages, "site-original")
        .await
        .unwrap();
    assert_eq!(pins(&f, false).await, owner);
    store
        .put(
            Table::Files,
            &json!({"id":"fixture-file","conversationId":CHAT,"name":"notes.txt"}),
        )
        .await
        .unwrap();
    let pinned_file = json!({"kind":"file","target":"fixture-file","pinned":true});
    let (one, two, repeat) = tokio::join!(
        update(&f, false, pinned_file.clone()),
        update(&f, false, pinned_file),
        update(&f, false, website_pin),
    );
    for (status, body) in [one, two, repeat] {
        assert_eq!(status, 200, "{body}");
    }
    let owner_both = pins(&f, false).await;
    assert_eq!(owner_both["pins"].as_array().unwrap().len(), 2);
    assert_eq!(owner_both["pins"][0]["target"], "fixture-file");
    assert_eq!(owner_both["pins"][1], owner["pins"][0]);
    assert_eq!(pins(&f, true).await["pins"].as_array().unwrap().len(), 1);
    assert_eq!(
        update(
            &f,
            true,
            json!({"kind":"website","target":key,"pinned":false})
        )
        .await
        .1,
        json!({"pins":[]})
    );
    assert_eq!(pins(&f, false).await, owner_both);
    assert!(f.bootstrap().await.get("libraryPins").is_none());

    store.delete(Table::Files, "fixture-file").await.unwrap();
    assert_eq!(pins(&f, false).await, owner);
    let unpin = json!({"kind":"file","target":"fixture-file","pinned":false});
    assert_eq!(update(&f, false, unpin.clone()).await, (200, owner.clone()));
    assert_eq!(update(&f, false, unpin).await, (200, owner));

    store.delete(Table::Conversations, CHAT).await.unwrap();
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM library_pins WHERE conversation_id=?")
            .bind(CHAT)
            .fetch_one(&store.pool)
            .await
            .unwrap();
    assert_eq!(remaining, 0);
    f.close().await;
}

#[tokio::test]
async fn pins_require_the_current_conversation_and_a_real_normalized_link() {
    let f = Fixture::new().await;
    let store = setup(&f).await;
    let other_key = "a".repeat(64);
    website(
        &store,
        OTHER_CHAT,
        "site-other",
        &"b".repeat(64),
        &other_key,
    )
    .await;
    store
        .put(
            Table::Files,
            &json!({"id":"other-file","conversationId":OTHER_CHAT,"name":"notes.txt"}),
        )
        .await
        .unwrap();
    store
        .put(
            Table::Files,
            &json!({"id":"workspace-file","name":"notes.txt"}),
        )
        .await
        .unwrap();
    for (id, cid, content) in [
        (
            "valid-source",
            CHAT,
            "[Open guide](https://example.com/guide) and `https://example.com/code`",
        ),
        (
            "other-source",
            OTHER_CHAT,
            "[Open guide](https://example.com/guide)",
        ),
    ] {
        store.put(Table::Messages, &json!({"id":id,"conversationId":cid,"role":"user","kind":"text","content":content})).await.unwrap();
    }
    for body in [
        json!({"kind":"website","target":other_key,"pinned":true}),
        json!({"kind":"file","target":"other-file","pinned":true}),
        json!({"kind":"link","target":"https://example.com/guide","pinned":true,"messageId":"other-source"}),
        json!({"kind":"link","target":"https://example.com/code","pinned":true,"messageId":"valid-source"}),
    ] {
        assert_eq!(update(&f, false, body).await.0, 404);
    }
    for body in [
        json!({"kind":"link","target":"https://example.com/guide","pinned":true}),
        json!({"kind":"link","target":"https://user:pass@example.com/guide","pinned":true,"messageId":"valid-source"}),
    ] {
        assert_eq!(update(&f, false, body).await.0, 400);
    }
    let valid_file = json!({"kind":"file","target":"workspace-file","pinned":true});
    assert_eq!(update(&f, false, valid_file).await.0, 200);
    let valid_link = json!({"kind":"link","target":"HTTPS://EXAMPLE.COM:443/guide","pinned":true,"messageId":"valid-source"});
    let (status, result) = update(&f, false, valid_link).await;
    assert_eq!(status, 200, "{result}");
    assert_eq!(result["pins"][0]["target"], "https://example.com/guide");
    assert!(result["pins"][0].get("messageId").is_none());
    assert_eq!(
        f.request("GET", &path(&f, CHAT), None, true, Some(&f.owner))
            .await
            .0,
        403
    );
    assert_eq!(
        f.request("GET", &path(&f, "missing"), None, false, Some(&f.owner))
            .await
            .0,
        404
    );

    store.delete(Table::Messages, "valid-source").await.unwrap();
    assert_eq!(pins(&f, false).await["pins"].as_array().unwrap().len(), 1);
    let unpin = json!({"kind":"link","target":"https://example.com/guide","pinned":false});
    assert_eq!(update(&f, false, unpin).await.0, 200);
    f.close().await;
}
