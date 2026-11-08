use super::{
    action_store,
    approvals::{self, ActionContext},
    controller, controls, frames, lifecycle, model, screen_bindings, takeover_frames,
    transport::Request as WorkerRequest,
    validation,
};
use crate::{
    db::State,
    error::{ApiError, Result},
    workspace::access,
};
use axum::{
    Json,
    body::to_bytes,
    extract::{Path, Request, State as Extract},
    http::{HeaderMap, Method, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

pub async fn cloud_status(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
) -> Result<Json<Value>> {
    let actor = access::require(&state, &headers, &wid, false, true).await?;
    let store = actor.store(&state).await?;
    let controller = state.computer.get(&state, store).await?;
    let value = controller.cloud.get(&state, &controller).await;
    actor.authorize(&state).await?;
    Ok(Json(value))
}
pub async fn cloud_start(
    Extract(state): Extract<State>,
    Path(wid): Path<String>,
    headers: HeaderMap,
    crate::error::Body(body): crate::error::Body,
) -> Result<Json<Value>> {
    crate::error::only_fields(&body, &[])?;
    let actor = access::require(&state, &headers, &wid, true, true).await?;
    let store = actor.store(&state).await?;
    let controller = state.computer.get(&state, store).await?;
    let authorize = controller::user_authority(&state, &actor);
    let operation = controller.cloud.enter()?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let _operation = operation;
        let result = async {
            let _maintenance = state.agent_runs.try_maintenance(&wid).await?;
            controller.cloud.start(&state, &controller, authorize).await
        }
        .await;
        let _ = sender.send(result);
    });
    Ok(Json(receiver.await.map_err(|_| {
        ApiError::new(502, "云电脑启动结果尚未确认，请刷新状态。")
    })??))
}

pub async fn dispatch(
    Extract(state): Extract<State>,
    Path((wid, tail)): Path<(String, String)>,
    headers: HeaderMap,
    request: Request,
) -> Result<Response> {
    let method = request.method().clone();
    let query = request.uri().query().unwrap_or("").to_owned();
    let parts: Vec<_> = tail.split('/').collect();
    let (agent, path) = if parts.first() == Some(&"bots") && parts.len() > 2 {
        if !model::opaque(parts[1]) {
            return Err(ApiError::bad("Bot 标识无效。"));
        }
        (Some(parts[1].to_owned()), parts[2..].join("/"))
    } else {
        (None, tail.clone())
    };
    let owner = matches!(
        path.as_str(),
        "connect"
            | "disconnect"
            | "reconnect"
            | "surface"
            | "prepare"
            | "release"
            | "reset"
            | "lifecycle/resume"
    );
    let actor = access::require(
        &state,
        &headers,
        &wid,
        owner,
        method != Method::GET || headers.contains_key("x-openbot-expected-user"),
    )
    .await?;
    let store = actor.store(&state).await?;
    let controller = state.computer.get(&state, store.clone()).await?;
    let authorize = controller::user_authority(&state, &actor);
    if method == Method::GET {
        let result = match path.as_str() {
            "status" => match agent.as_deref() {
                Some(agent) => {
                    screen_bindings::status(&controller, agent, authorize.clone()).await?
                }
                None => controller.refresh(authorize.clone()).await,
            },
            "bots" if agent.is_none() => {
                screen_bindings::list(&controller, authorize.clone()).await?
            }
            "actions" => json!(action_store::list(&store, agent.as_deref()).await?),
            "takeover/status" => {
                controls::takeover_status(&controller, agent.as_deref(), authorize.clone()).await?
            }
            "screenshot" => {
                let reply =
                    controls::screenshot(&controller, agent.as_deref(), authorize.clone()).await?;
                return takeover_frames::response(reply, "shared");
            }
            "files" => {
                let values: std::collections::HashMap<_, _> =
                    url::form_urlencoded::parse(query.as_bytes())
                        .into_owned()
                        .collect();
                let path = validation::path(
                    &values.get("path").map(|s| json!(s)).unwrap_or(Value::Null),
                    Some("."),
                )?;
                let encoded: String =
                    url::form_urlencoded::byte_serialize(path.as_bytes()).collect();
                let target = controller.target(authorize.clone()).await?;
                let list = target
                    .request(
                        WorkerRequest::get(format!("/files?path={encoded}")),
                        authorize.clone(),
                    )
                    .await?
                    .json()?;
                if list["path"] != path
                    || !list["entries"].as_array().is_some_and(|a| a.len() <= 1000)
                    || !list["truncated"].is_boolean()
                {
                    return Err(model::invalid());
                }
                list
            }
            _ if path.starts_with("frames/") && agent.is_none() => {
                let bytes = frames::read(&store, &path[7..]).await?;
                authorize().await?;
                return Ok((
                    [
                        (header::CONTENT_TYPE, "image/webp"),
                        (header::CACHE_CONTROL, "private, no-store"),
                    ],
                    bytes,
                )
                    .into_response());
            }
            _ => return Err(ApiError::new(404, "电脑接口不存在。")),
        };
        actor.authorize(&state).await?;
        return Ok(Json(result).into_response());
    }
    if method != Method::POST {
        return Err(ApiError::new(405, "电脑接口不支持此请求方式。"));
    }
    let bytes = to_bytes(request.into_body(), 512 * 1024)
        .await
        .map_err(|_| ApiError::new(413, "电脑请求内容过大。"))?;
    let body: Value = if bytes.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("电脑请求格式无效。"))?
    };
    actor.authorize(&state).await?;
    let _maintenance =
        if agent.is_none() && matches!(path.as_str(), "connect" | "reconnect" | "disconnect") {
            Some(state.agent_runs.try_maintenance(&wid).await?)
        } else {
            None
        };
    let result = match path.as_str() {
        "takeover/screenshot" => {
            crate::error::only_fields(&body, &[])?;
            return takeover_frames::private(
                &controller,
                agent.as_deref(),
                &actor,
                &headers,
                authorize.clone(),
            )
            .await;
        }
        "connect" if agent.is_none() => {
            if body["mode"] == "local" {
                controller.connect_local(authorize.clone()).await?
            } else if body["mode"] != "remote" {
                return Err(ApiError::new(400, "请选择有效的电脑连接方式。"));
            } else {
                controller
                    .connect(
                        body["url"].as_str().unwrap_or(""),
                        body["token"].as_str().unwrap_or(""),
                        authorize.clone(),
                    )
                    .await?
            }
        }
        "reconnect" if agent.is_none() => controller.reconnect(authorize.clone()).await?,
        "disconnect" if agent.is_none() => controller.disconnect(authorize.clone()).await?,
        "prepare" if agent.is_some() => {
            screen_bindings::prepare(&controller, agent.as_deref().unwrap(), authorize.clone())
                .await?
        }
        "release" | "reset" if agent.is_some() => {
            lifecycle::begin(
                &controller,
                agent.as_deref().unwrap(),
                &path,
                &body,
                authorize.clone(),
            )
            .await?
        }
        "lifecycle/resume" if agent.is_some() => {
            lifecycle::resume(
                &controller,
                agent.as_deref().unwrap(),
                &body,
                authorize.clone(),
            )
            .await?
        }
        "surface" => {
            controls::surface(&controller, agent.as_deref(), &body, authorize.clone()).await?
        }
        "takeover/start" => {
            crate::error::only_fields(&body, &[])?;
            controls::start(&controller, agent.as_deref(), &actor, authorize.clone()).await?
        }
        "takeover/input" => {
            controls::input(
                &controller,
                agent.as_deref(),
                &actor,
                &body,
                authorize.clone(),
            )
            .await?
        }
        "takeover/end" => {
            controls::end(
                &controller,
                agent.as_deref(),
                &actor,
                &body,
                authorize.clone(),
            )
            .await?
        }
        "actions" => {
            if [
                "requester",
                "authorize",
                "runId",
                "userId",
                "approvedBy",
                "messageId",
            ]
            .iter()
            .any(|field| body.get(field).is_some())
            {
                return Err(ApiError::bad("操作身份必须由当前登录会话提供。"));
            }
            let context = ActionContext {
                agent_id: agent.clone(),
                conversation_id: body["conversationId"].as_str().map(str::to_owned),
                requester: Some(json!({"userId":actor.user_id,"name":actor.user_name})),
                ..Default::default()
            };
            approvals::request(&controller, &body, context, authorize.clone()).await?
        }
        _ if path.starts_with("actions/") => {
            let items: Vec<_> = path.split('/').collect();
            if items.len() != 3
                || !model::uuid(items[1])
                || !["approve", "reject"].contains(&items[2])
            {
                return Err(ApiError::new(404, "电脑操作不存在。"));
            }
            let current = action_store::get(&store, items[1]).await?;
            if agent.as_ref().is_some_and(|a| current["agentId"] != *a) {
                return Err(ApiError::new(404, "电脑操作不属于此 Bot。"));
            }
            approvals::decide(&state, &controller, items[1], items[2] == "approve", &actor).await?
        }
        _ => return Err(ApiError::new(404, "电脑接口不存在。")),
    };
    actor.authorize(&state).await?;
    let mut response = Json(result).into_response();
    if path == "takeover/start" {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    }
    Ok(response)
}
