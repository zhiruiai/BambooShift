mod bot_templates_support;
use bot_templates_support::{Templates, id, token};
use openbot_backend::workspace::Table;
use serde_json::{Value, json};

async fn public(t: &Templates, token: &str) -> (u16, Value) {
    t.f.with_cookie(
        "GET",
        &format!("/api/bot-template-links/{token}"),
        None,
        "",
        None,
    )
    .await
}
#[tokio::test]
async fn draft_publish_edit_revoke_keep_exact_versions_and_one_reaction_preserving_chat_card() {
    let t = Templates::new().await;
    t.public_policy().await;
    let mut draft = t.create().await;
    assert_eq!(draft["projectionPending"], false);
    assert!(draft.get("publication").is_none());
    let mid = draft["messageId"].as_str().unwrap().to_owned();
    let mut card = t.store.get(Table::Messages, &mid).await.unwrap().unwrap();
    card["reactions"] = json!([{"emoji":"👍","userId":t.f.owner}]);
    t.store.put(Table::Messages, &card).await.unwrap();
    let mut blueprint = draft["blueprint"].clone();
    blueprint["profile"]["name"] = json!("Approved public identity");
    blueprint["profile"]["instructions"] = json!("Only the selected public method.");
    blueprint["routines"] = json!([]);
    let (status,edited)=t.call("PATCH",&format!("/bot-templates/{}",draft["id"].as_str().unwrap()),Some(json!({"requestId":id(),"expectedRevision":draft["revision"],"expectedDraftRevision":draft["draftRevision"],"blueprint":blueprint}))).await;
    assert_eq!(status, 200, "{edited}");
    draft = edited;
    card = t.store.get(Table::Messages, &mid).await.unwrap().unwrap();
    assert_ne!(
        card["metadata"]["botTemplate"]["name"],
        "Approved public identity"
    );
    let published = t.publish(&draft, "public").await;
    let link = token(&published);
    let (status, first) = public(&t, &link).await;
    assert_eq!(status, 200, "{first}");
    assert_eq!(first["blueprint"], blueprint);
    let mut private = blueprint.clone();
    private["profile"]["name"] = json!("PRIVATE UNPUBLISHED DRAFT");
    let (status,edited)=t.call("PATCH",&format!("/bot-templates/{}",published["id"].as_str().unwrap()),Some(json!({"requestId":id(),"expectedRevision":published["revision"],"expectedDraftRevision":published["draftRevision"],"blueprint":private}))).await;
    assert_eq!(status, 200);
    let (_, still) = public(&t, &link).await;
    assert_eq!(still, first);
    card = t.store.get(Table::Messages, &mid).await.unwrap().unwrap();
    assert_eq!(
        card["metadata"]["botTemplate"]["name"],
        "Approved public identity"
    );
    assert_eq!(card["reactions"].as_array().unwrap().len(), 1);
    assert_eq!(t.store.list(Table::Messages).await.unwrap().len(), 1);
    let request = id();
    let body = json!({"requestId":request,"expectedRevision":edited["revision"]});
    let (status, revoked) = t
        .call(
            "POST",
            &format!("/bot-templates/{}/revoke", edited["id"].as_str().unwrap()),
            Some(body.clone()),
        )
        .await;
    assert_eq!(status, 200);
    assert!(revoked.get("publication").is_none());
    assert_eq!(public(&t, &link).await.0, 404);
    let republished = t.publish(&revoked, "public").await;
    assert_ne!(token(&republished), link);
    assert_eq!(public(&t, &link).await.0, 404);
    let (_, replay) = t
        .call(
            "POST",
            &format!("/bot-templates/{}/revoke", edited["id"].as_str().unwrap()),
            Some(body),
        )
        .await;
    assert_eq!(replay["publication"], republished["publication"]);
    t.close().await;
}
#[tokio::test]
async fn team_preview_requires_fixed_account_and_import_is_independent_and_restorable_after_revoke()
{
    let t = Templates::new().await;
    let draft = t.create().await;
    let published = t.publish(&draft, "team").await;
    let link = token(&published);
    let path = format!("/api/bot-template-links/{link}");
    assert_eq!(public(&t, &link).await.0, 401);
    assert_eq!(t.f.request("GET", &path, None, true, None).await.0, 401);
    assert_eq!(
        t.f.request("GET", &path, None, true, Some(&t.f.owner))
            .await
            .0,
        403
    );
    let (status, preview) =
        t.f.request("GET", &path, None, true, Some(&t.f.member))
            .await;
    assert_eq!(status, 200);
    let target = t.personal(&t.f.member).await;
    let endpoint = format!("/api/workspaces/{target}/bot-template-imports");
    let body = json!({"requestId":id(),"token":link,"expectedRevision":preview["revision"],"name":"My private independent Bot","routineMode":"pause"});
    let (status, receipt) =
        t.f.request(
            "POST",
            &endpoint,
            Some(body.clone()),
            true,
            Some(&t.f.member),
        )
        .await;
    assert_eq!(status, 201, "{receipt}");
    let target_store = t.f.state.workspace.get(&target, &target).await.unwrap();
    let bot = target_store
        .get(Table::Agents, receipt["agentId"].as_str().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert!(bot.get("sharedBot").is_none());
    assert!(target_store.list(Table::Memories).await.unwrap().is_empty());
    assert!(target_store.list(Table::Messages).await.unwrap().is_empty());
    assert_eq!(
        target_store
            .get(Table::Routines, receipt["routineIds"][0].as_str().unwrap())
            .await
            .unwrap()
            .unwrap()["enabled"],
        false
    );
    let (status, _) = t
        .call(
            "POST",
            &format!(
                "/bot-templates/{}/revoke",
                published["id"].as_str().unwrap()
            ),
            Some(json!({"requestId":id(),"expectedRevision":published["revision"]})),
        )
        .await;
    assert_eq!(status, 200);
    let (status, replay) =
        t.f.request(
            "POST",
            &endpoint,
            Some(body.clone()),
            true,
            Some(&t.f.member),
        )
        .await;
    assert_eq!(status, 201);
    assert_eq!(replay, receipt);
    let (status, get) =
        t.f.request(
            "GET",
            &format!("{endpoint}/{}", receipt["requestId"].as_str().unwrap()),
            None,
            true,
            Some(&t.f.member),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(get, receipt);
    let mut next = body;
    next["requestId"] = json!(id());
    assert_eq!(
        t.f.request("POST", &endpoint, Some(next), true, Some(&t.f.member))
            .await
            .0,
        404
    );
    assert_eq!(target_store.list(Table::Agents).await.unwrap().len(), 2);
    t.close().await;
}
#[tokio::test]
async fn policy_tightening_permanently_revokes_old_links_and_public_reads_never_open_source_storage()
 {
    let t = Templates::new().await;
    t.public_policy().await;
    let draft = t.create().await;
    let published = t.publish(&draft, "public").await;
    let link = token(&published);
    let original = t.store.directory.clone();
    let moved = original.with_extension("held");
    std::fs::rename(&original, &moved).unwrap();
    let (status, preview) = public(&t, &link).await;
    assert_eq!(status, 200, "{preview}");
    assert!(!original.exists());
    std::fs::rename(&moved, &original).unwrap();
    let (_, policy) = t.call("GET", "/bot-sharing-policy", None).await;
    let (status, disabled) = t
        .call(
            "PUT",
            "/bot-sharing-policy",
            Some(json!({"expectedRevision":policy["revision"],"mode":"team-only"})),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(public(&t, &link).await.0, 404);
    let (status, _) = t
        .call(
            "PUT",
            "/bot-sharing-policy",
            Some(json!({"expectedRevision":disabled["revision"],"mode":"public"})),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(public(&t, &link).await.0, 404);
    let (_, current) = t
        .call(
            "GET",
            &format!("/bot-templates/{}", draft["id"].as_str().unwrap()),
            None,
        )
        .await;
    let next = t.publish(&current, "public").await;
    let new = token(&next);
    sqlx::query("DELETE FROM memberships WHERE workspace_id=? AND user_id=?")
        .bind(&t.f.workspace)
        .bind(&t.f.owner)
        .execute(&t.f.db)
        .await
        .unwrap();
    assert_eq!(public(&t, &new).await.0, 404);
    t.close().await;
}
#[tokio::test]
async fn owner_mutations_use_cas_and_old_source_receipt_recovery_never_recreates_or_leaks_drafts() {
    let t = Templates::new().await;
    let source = t.source().await;
    let request = id();
    let body = json!({"requestId":request,"sourceAgentId":t.agent,"sourceConversationId":t.conversation,"expectedSourceRevision":source["sourceRevision"]});
    let (status, draft) = t.call("POST", "/bot-templates", Some(body.clone())).await;
    assert_eq!(status, 201);
    assert_eq!(
        t.f.request(
            "GET",
            &t.f.path("/bot-templates"),
            None,
            true,
            Some(&t.f.member)
        )
        .await
        .0,
        403
    );
    let change = json!({"requestId":id(),"expectedRevision":draft["revision"],"expectedDraftRevision":draft["draftRevision"],"blueprint":draft["blueprint"]});
    let path = format!("/bot-templates/{}", draft["id"].as_str().unwrap());
    let (a,b)=tokio::join!(t.call("PATCH",&path,Some(change.clone())),t.call("PATCH",&path,Some(json!({"requestId":id(),"expectedRevision":draft["revision"],"expectedDraftRevision":draft["draftRevision"],"blueprint":draft["blueprint"]}))));
    assert!(
        a.0 == 200 && b.0 == 409 || b.0 == 200 && a.0 == 409,
        "{a:?} {b:?}"
    );
    t.store.delete(Table::Agents, &t.agent).await.unwrap();
    let (status, replay) = t.call("POST", "/bot-templates", Some(body)).await;
    assert_eq!(status, 201);
    assert_eq!(replay["id"], draft["id"]);
    let (status, results) = t
        .call("GET", &format!("/bot-templates?requestId={request}"), None)
        .await;
    assert_eq!(status, 200);
    assert_eq!(results[0]["revision"], replay["revision"]);
    let (status, gallery) =
        t.f.with_cookie("GET", "/api/bot-template-gallery", None, "", None)
            .await;
    assert_eq!(status, 200);
    assert!(gallery.as_array().unwrap().is_empty());
    t.close().await;
}
