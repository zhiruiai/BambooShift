use super::current_research_guidance;
use serde_json::json;

#[test]
fn research_guidance_uses_only_complete_retrieval_paths() {
    let restricted = current_research_guidance(&[
        json!({"name":"list_apps"}),
        json!({"name":"computer_status"}),
        json!({"name":"computer_action","parameters":{"properties":{"type":{"enum":["read_file"]}}}}),
    ]);
    assert!(restricted.contains("no live search route"));
    assert!(!restricted.contains("list_apps"));
    assert!(!restricted.contains("browser_navigate"));
    let shared = current_research_guidance(&[
        json!({"name":"shared_app_list"}),
        json!({"name":"shared_app_tools"}),
        json!({"name":"shared_app_call"}),
    ]);
    assert!(shared.contains("explicitly granted publisher search app"));
    assert!(!shared.contains("no live search route"));
    assert!(!shared.contains("computer_action"));
    assert!(shared.contains("Cite verified source URLs and publication or update dates"));
}

#[test]
fn public_search_does_not_require_a_browser_or_connected_app() {
    let mut tools = super::super::web_tools::definitions().to_vec();
    tools.push(json!({"name":"computer_status"}));
    tools.push(json!({"name":"computer_action","parameters":{"properties":{"type":{"enum":["browser_navigate"]}}}}));
    let guidance = current_research_guidance(&tools);
    assert!(guidance.contains("Use web_search first"));
    assert!(guidance.contains("Use web_fetch first"));
    assert!(guidance.contains("public search keywords"));
    assert!(guidance.contains("untrusted evidence"));
    assert!(guidance.contains("latest human correction"));
    assert!(!guidance.contains("no live search route"));
    assert!(!guidance.contains("computer_status"));
}
