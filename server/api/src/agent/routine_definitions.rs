use serde_json::{Value, json};

pub(crate) fn definitions() -> Vec<Value> {
    let id = json!({"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9_-]+$"});
    let revision = json!({"type":"string","pattern":"^[a-f0-9]{64}$"});
    let fields = json!({
        "title":{"type":"string","minLength":1,"maxLength":100},
        "prompt":{"type":"string","minLength":1,"maxLength":12000},
        "schedule":{"type":"string","maxLength":80,"description":"daily:HH:mm, weekly:1,3,5:HH:mm (Monday=1), or interval:N elapsed minutes. Use the human's requested time."},
        "timeZone":{"type":"string","maxLength":100,"description":"IANA time zone. Omit when creating to use the workspace default; omit when updating to preserve the task zone."}
    });
    let object = |properties: Value, required: Value| json!({"type":"object","additionalProperties":false,"properties":properties,"required":required});
    let mut create = fields.clone();
    create["enabled"] = json!({"type":"boolean"});
    let mut changes = object(fields, json!([]));
    changes["minProperties"] = json!(1);
    vec![
        json!({"name":"routine_list","description":"Read this Bot's routines in the current workspace. List summaries first; use routineId to read the full prompt and exact revision before editing. No task is executed.","parameters":object(json!({"routineId":id}),json!([]))}),
        json!({"name":"routine_create","description":"Create a routine explicitly requested by the workspace owner in this conversation. This saves a future schedule and never executes its prompt now. Uses the current workspace time zone unless explicitly specified.","parameters":object(create,json!(["title","prompt","schedule"]))}),
        json!({"name":"routine_update","description":"Update this Bot's routine after reading its exact current revision. Omitted fields stay unchanged; schedule or time zone changes recompute its next future run. Never executes the routine now.","parameters":object(json!({"routineId":id,"expectedRevision":revision,"changes":changes}),json!(["routineId","expectedRevision","changes"]))}),
        json!({"name":"routine_pause","description":"Pause (paused=true) or resume (paused=false) this Bot's routine using its current revision. Resuming schedules its next future run; this does not stop work already running.","parameters":object(json!({"routineId":id,"expectedRevision":revision,"paused":{"type":"boolean"}}),json!(["routineId","expectedRevision","paused"]))}),
        json!({"name":"routine_delete","description":"Delete this Bot's routine only when the human asks, using its exact current revision. Keeps chat history and does not stop an already running task.","parameters":object(json!({"routineId":id,"expectedRevision":revision}),json!(["routineId","expectedRevision"]))}),
    ]
}
