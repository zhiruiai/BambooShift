mod workspace_support;

use openbot_backend::{config::Config, db::State};
use serde_json::{Value, json};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::time::Duration;
use workspace_support::Fixture;

const SOURCE_BOT: &str = "Synthetic private author label";
const SOURCE_NAME: &str = "Synthetic personal workspace label";
const SKILL: &str = "Review a synthetic result";
const DESCRIPTION: &str = "Review only the artifact shared with the team.";

struct Case {
    f: Fixture,
    personal: String,
    bot: Value,
}

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

async fn personal(f: &Fixture, member: bool) -> String {
    let wid = id();
    let user = if member { &f.member } else { &f.owner };
    sqlx::query("INSERT INTO workspaces VALUES(?,?,'personal','active',?,1)")
        .bind(&wid)
        .bind(SOURCE_NAME)
        .bind(&wid)
        .execute(&f.db)
        .await
        .unwrap();
    sqlx::query("INSERT INTO memberships VALUES(?,?,'owner',1)")
        .bind(&wid)
        .bind(user)
        .execute(&f.db)
        .await
        .unwrap();
    wid
}

impl Case {
    async fn new() -> Self {
        let f = Fixture::new().await;
        let personal = personal(&f, false).await;
        let (status, bot) = f
            .request(
                "POST",
                &format!("/api/workspaces/{personal}/agents"),
                Some(json!({"name":SOURCE_BOT})),
                false,
                Some(&f.owner),
            )
            .await;
        assert_eq!(status, 201, "{bot}");
        Self { f, personal, bot }
    }

    async fn request(&self, method: &str, path: &str, body: Option<Value>) -> (u16, Value) {
        self.f
            .request(method, path, body, false, Some(&self.f.owner))
            .await
    }

    fn source(&self, path: &str) -> String {
        format!("/api/workspaces/{}{path}", self.personal)
    }

    fn targets(&self, skill: &Value) -> String {
        self.source(&format!(
            "/private-skills/{}/team-publication-targets",
            skill["id"].as_str().unwrap()
        ))
    }

    fn publication(&self, skill: &Value) -> String {
        self.source(&format!(
            "/private-skills/{}/team-publications/{}",
            skill["id"].as_str().unwrap(),
            self.f.workspace
        ))
    }

    async fn draft(&self, content: &str, description: &str) -> Value {
        let (status, value) = self.request("POST", &self.source("/skills"), Some(json!({
            "agentId":self.bot["id"],"name":SKILL,"description":description,"content":content,
        }))).await;
        assert_eq!(status, 201, "{value}");
        value
    }

    async fn approve(&self, draft: &Value, previous: Value) -> Value {
        let path = self.source(&format!(
            "/skills/{}/approve",
            draft["id"].as_str().unwrap()
        ));
        let (status, value) = self
            .request("POST", &path, Some(json!({"expectedActiveId":previous})))
            .await;
        assert_eq!(status, 200, "{value}");
        assert_eq!(value["status"], "active");
        value
    }

    async fn proof(&self, skill: &Value) -> Value {
        let (status, shelf) = self
            .request("GET", &self.source("/private-skills"), None)
            .await;
        assert_eq!(status, 200, "{shelf}");
        shelf["skills"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == skill["id"])
            .unwrap()["revision"]
            .clone()
    }

    async fn list_as_member(&self) -> Value {
        let (status, list) = self
            .f
            .request(
                "GET",
                &self.f.path("/team-skills"),
                None,
                true,
                Some(&self.f.member),
            )
            .await;
        assert_eq!(status, 200, "{list}");
        list
    }
}

fn submission(source: Value, prior: Value) -> Value {
    json!({"requestId":id(),"expectedSourceRevision":source,"expectedPublicationRevision":prior})
}

fn receipt(path: &str, request: &Value) -> String {
    format!("{path}/{}", request["requestId"].as_str().unwrap())
}

#[tokio::test]
async fn personal_publications_reuse_team_snapshots_with_private_provenance_and_restart_receipts() {
    let mut c = Case::new().await;
    let member_space = personal(&c.f, true).await;
    let first = c.draft("First approved instructions.", DESCRIPTION).await;
    let path = c.publication(&first);
    let invalid = submission(json!("a".repeat(64)), Value::Null);
    assert_eq!(
        c.request("PUT", &path, Some(invalid)).await.1["code"],
        "TEAM_SKILL_SOURCE_CHANGED"
    );
    c.approve(&first, Value::Null).await;
    let exact = c.proof(&first).await;
    let body = submission(exact.clone(), Value::Null);
    let (status, targets) = c.request("GET", &c.targets(&first), None).await;
    assert_eq!(status, 200, "{targets}");
    assert_eq!(
        targets,
        json!({"teams":[{"workspaceId":c.f.workspace,"workspaceName":"Synthetic","publication":null,"policyRevision":null}]})
    );
    assert_eq!(
        c.f.request("PUT", &path, Some(body.clone()), false, Some(&c.f.member))
            .await
            .0,
        403
    );
    assert_eq!(
        c.f.request("PUT", &path, Some(body.clone()), true, Some(&c.f.member))
            .await
            .0,
        403
    );
    let member_path = path.replace(&c.personal, &member_space);
    assert_eq!(
        c.f.request(
            "PUT",
            &member_path,
            Some(body.clone()),
            true,
            Some(&c.f.member)
        )
        .await
        .0,
        403
    );

    let (status, saved) = c.request("PUT", &path, Some(body.clone())).await;
    assert_eq!(status, 200, "{saved}");
    let summary = &saved["publication"];
    assert_eq!(summary["version"], 1);
    assert_eq!(summary["sourceRevision"], exact);
    assert_eq!(
        c.request("PUT", &path, Some(body.clone())).await,
        (200, saved.clone())
    );
    assert_eq!(
        c.request("DELETE", &receipt(&path, &body), None).await,
        (200, saved.clone())
    );
    let mut mismatch = body.clone();
    mismatch["expectedSourceRevision"] = json!("b".repeat(64));
    assert_eq!(
        c.request("PUT", &path, Some(mismatch)).await.1["code"],
        "TEAM_SKILL_REQUEST_CONFLICT"
    );

    let listed = c.list_as_member().await;
    assert_eq!(
        listed[0]["source"],
        json!({"origin":"personal","version":1})
    );
    assert_eq!(listed[0]["content"], "First approved instructions.");
    assert_eq!(listed[0]["description"], DESCRIPTION);
    for hidden in [
        SOURCE_BOT,
        SOURCE_NAME,
        c.personal.as_str(),
        c.bot["id"].as_str().unwrap(),
        first["id"].as_str().unwrap(),
        exact.as_str().unwrap(),
    ] {
        assert!(!listed.to_string().contains(hidden), "{listed}");
    }
    let team_bot = c.f.bootstrap().await["agents"][0]["id"].clone();
    let item = summary["id"].as_str().unwrap();
    let import = c.f.path(&format!("/team-skills/{item}/import"));
    let (status, pinned) = c
        .request(
            "POST",
            &import,
            Some(json!({"expectedRevision":summary["revision"],"agentId":team_bot})),
        )
        .await;
    assert_eq!(status, 200, "{pinned}");
    assert_eq!(pinned["status"], "proposed");
    assert_eq!(pinned["content"], listed[0]["content"]);

    let second = c.draft("Second approved instructions.", DESCRIPTION).await;
    c.approve(&second, first["id"].clone()).await;
    let second_path = c.publication(&second);
    let proof = c.proof(&second).await;
    assert_eq!(
        c.request("GET", &c.targets(&second), None).await.1["teams"][0]["publication"],
        *summary
    );
    let stale = submission(proof.clone(), Value::Null);
    assert_eq!(
        c.request("PUT", &second_path, Some(stale)).await.1["code"],
        "TEAM_SKILL_REVISION"
    );
    let (status, synced) = c
        .request(
            "PUT",
            &second_path,
            Some(submission(proof, summary["revision"].clone())),
        )
        .await;
    assert_eq!(status, 200, "{synced}");
    assert_eq!(synced["publication"]["id"], item);
    assert_eq!(synced["publication"]["version"], 2);
    assert_eq!(
        c.list_as_member().await[0]["content"],
        "Second approved instructions."
    );
    assert_eq!(
        c.request("PUT", &path, Some(body.clone())).await,
        (200, saved.clone())
    );

    let unpublish = c.f.path(&format!("/team-skills/{item}/unpublish"));
    assert_eq!(
        c.request(
            "POST",
            &unpublish,
            Some(json!({"expectedRevision":synced["publication"]["revision"]}))
        )
        .await
        .0,
        200
    );
    assert_eq!(c.list_as_member().await, json!([]));
    c.f.state.close().await;
    c.f.state = State::open(Config::local(c.f.directory.path()))
        .await
        .unwrap();
    assert_eq!(
        c.request("GET", &receipt(&path, &body), None).await,
        (200, saved.clone())
    );
    assert_eq!(c.request("PUT", &path, Some(body)).await, (200, saved));
    assert_eq!(c.list_as_member().await, json!([]));
    c.f.close().await;
}

#[tokio::test]
async fn closing_and_publishing_race_to_one_durable_outcome() {
    let c = Case::new().await;
    let draft = c.draft("Race a synthetic publication.", DESCRIPTION).await;
    c.approve(&draft, Value::Null).await;
    let path = c.publication(&draft);
    let body = submission(c.proof(&draft).await, Value::Null);
    let get = receipt(&path, &body);
    let missing = c.request("GET", &get, None).await;
    assert_eq!(missing.0, 404);
    assert_eq!(missing.1["code"], "TEAM_SKILL_PUBLICATION_NOT_FOUND");
    let (published, cancelled) = tokio::join!(
        c.request("PUT", &path, Some(body.clone())),
        c.request("DELETE", &get, None)
    );
    assert_eq!(cancelled.0, 200, "{cancelled:?}");
    assert_eq!(c.request("GET", &get, None).await, cancelled);
    assert_eq!(c.request("DELETE", &get, None).await, cancelled);
    if cancelled.1["status"] == "cancelled" {
        assert_eq!(published.0, 409, "{published:?}");
        assert_eq!(published.1["code"], "TEAM_SKILL_REQUEST_CLOSED");
        assert_eq!(c.list_as_member().await, json!([]));
    } else {
        assert_eq!(published, cancelled);
        assert_eq!(c.list_as_member().await.as_array().unwrap().len(), 1);
    }
    let never = submission(c.proof(&draft).await, Value::Null);
    let never_url = receipt(&path, &never);
    assert_eq!(
        c.request("DELETE", &never_url, None).await,
        (200, json!({"status":"cancelled"}))
    );
    assert_eq!(
        c.request("PUT", &path, Some(never)).await.1["code"],
        "TEAM_SKILL_REQUEST_CLOSED"
    );
    c.f.close().await;
}

#[tokio::test]
async fn permission_revocation_while_waiting_for_the_personal_lock_cannot_commit() {
    let c = Case::new().await;
    let draft = c
        .draft("Never publish after permission changes.", DESCRIPTION)
        .await;
    c.approve(&draft, Value::Null).await;
    let proof = c.proof(&draft).await;
    let path = c.publication(&draft);
    let body = submission(proof, Value::Null);
    let personal =
        c.f.state
            .workspace
            .get(&c.personal, &c.personal)
            .await
            .unwrap();
    let team =
        c.f.state
            .workspace
            .get(&c.f.workspace, &c.f.workspace)
            .await
            .unwrap();
    let held = personal.begin().await.unwrap();
    let mut watcher = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(team.directory.join("openbot.sqlite"))
            .busy_timeout(Duration::ZERO),
    )
    .await
    .unwrap();
    let revoke = async {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match sqlx::query("BEGIN IMMEDIATE").execute(&mut watcher).await {
                    Ok(_) => {
                        sqlx::query("ROLLBACK").execute(&mut watcher).await.unwrap();
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    Err(error)
                        if error.as_database_error().and_then(|e| e.code()).as_deref()
                            == Some("5") =>
                    {
                        break;
                    }
                    Err(error) => panic!("Unexpected SQLite error: {error}"),
                }
            }
        })
        .await
        .expect("Publication never acquired the team writer lock");
        sqlx::query("DELETE FROM account_sessions WHERE user_id=? AND purpose='account'")
            .bind(&c.f.owner)
            .execute(&c.f.db)
            .await
            .unwrap();
        held.rollback().await.unwrap();
    };
    let (result, _) = tokio::join!(c.request("PUT", &path, Some(body)), revoke);
    assert_eq!(result.0, 403, "{result:?}");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM team_skill_publication_requests")
        .fetch_one(&team.pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(c.list_as_member().await, json!([]));
    watcher.close().await.unwrap();
    c.f.close().await;
}

#[tokio::test]
async fn legacy_active_snapshots_get_stable_links_without_restoring_withdrawn_entries() {
    let mut f = Fixture::new().await;
    let active = id();
    let withdrawn = id();
    let team = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    for (item, closed) in [(&active, false), (&withdrawn, true)] {
        let mut snapshot = json!({"id":item,"revision":id(),"version":2,"name":"Legacy workflow",
            "content":"Synthetic legacy approved instructions","description":"Legacy description",
            "source":{"origin":"personal","version":2}});
        if closed {
            snapshot["withdrawnAt"] = json!("2025-01-01T00:00:00Z");
        }
        sqlx::query("INSERT INTO team_skill_publications VALUES(?,?,?,?)")
            .bind(item)
            .bind(format!("personal:{item}"))
            .bind("Legacy workflow")
            .bind(snapshot.to_string())
            .execute(&team.pool)
            .await
            .unwrap();
    }
    let mut expected_link = None;
    for _ in 0..2 {
        f.state.close().await;
        f.state = State::open(Config::local(f.directory.path()))
            .await
            .unwrap();
        let (status, catalog) = f
            .request("GET", &f.path("/team-skills"), None, true, Some(&f.member))
            .await;
        assert_eq!(status, 200, "{catalog}");
        assert_eq!(catalog.as_array().unwrap().len(), 1);
        assert_eq!(catalog[0]["id"], active);
        assert_eq!(catalog[0]["canWithdraw"], false);
        let link = catalog[0]["linkId"].as_str().unwrap();
        assert!(uuid::Uuid::parse_str(link).is_ok());
        let path = f.path(&format!("/team-skills/{active}/link/{link}"));
        assert_eq!(
            f.request("GET", &path, None, true, Some(&f.member)).await,
            (200, catalog[0].clone())
        );
        match &expected_link {
            Some(expected) => assert_eq!(link, expected),
            None => expected_link = Some(link.to_owned()),
        }
    }
    let team = f
        .state
        .workspace
        .get(&f.workspace, &f.workspace)
        .await
        .unwrap();
    let link: Option<String> = sqlx::query_scalar(
        "SELECT json_extract(data,'$.linkId') FROM team_skill_publications WHERE id=?",
    )
    .bind(withdrawn)
    .fetch_one(&team.pool)
    .await
    .unwrap();
    assert!(link.is_none());
    f.close().await;
}
