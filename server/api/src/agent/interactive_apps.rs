use super::{
    authority::ExecutionAccess,
    tools::{ToolContext, check_fence},
};
use crate::{
    apps::{interactive_policy::Candidate, model::PreparedCall},
    error::Result,
    workspace::WorkspaceStore,
};

pub(super) fn candidate(
    access: &ExecutionAccess,
    store: &WorkspaceStore,
    context: &ToolContext<'_>,
    prepared: &PreparedCall,
) -> Result<Option<Candidate>> {
    let ExecutionAccess::User(actor) = access else {
        return Ok(None);
    };
    let active = context.active;
    let input = context.input;
    if actor.kind != "personal"
        || !actor.is_owner
        || actor.workspace_id != store.workspace_id
        || active.kind != "user"
        || active.depth != 0
        || active.background
        || active.thread_root_id.is_some()
        || active.family.isolated_voice()
        || active.run_id != active.root_run_id
        || active.user_id != actor.user_id
        || active.message_id != active.requester_message_id
        || input["id"] != active.requester_message_id
        || input["role"] != "user"
        || input["kind"] != "text"
        || input["userId"] != actor.user_id
        || input["conversationId"] != active.conversation_id
        || prepared.tool_name != "issue_read"
    {
        return Ok(None);
    }
    let Some(selected) = active.family.app_context.get() else {
        return Ok(None);
    };
    selected.authorize_call(&prepared.connection_id, &prepared.connection_revision)?;
    if input["appContext"]["connectionId"] != selected.connection_id
        || input["appContext"]["revision"] != selected.revision
    {
        return Ok(None);
    }
    check_fence(active, context.generation)?;
    Ok(Some(Candidate {
        actor: actor.clone(),
        conversation_id: active.conversation_id.clone(),
        agent_id: active.agent_id.clone(),
        requester_message_id: active.requester_message_id.clone(),
        run_id: active.run_id.clone(),
        connection_id: selected.connection_id.clone(),
        connection_revision: selected.revision.clone(),
    }))
}
