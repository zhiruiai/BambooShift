use crate::error::{ApiError, Result};
use serde_json::Value;

const LIMIT: usize = 10 * 1024 * 1024;

pub struct Transcript {
    pub content: String,
    pub count: usize,
    zh: bool,
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn line(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .flat_map(|c| {
            if "\\`*_{}[]<>#!|".contains(c) {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect()
}
fn basename(value: &str) -> &str {
    value.rsplit(['/', '\\']).next().unwrap_or("")
}

impl Transcript {
    pub fn new(conversation: &Value, exported: &str, zh: bool) -> Result<Self> {
        let mut result = Self {
            content: String::new(),
            count: 0,
            zh,
        };
        result.append(&format!("# {}\n\n{}: {}\n\n{}\n",
            line(text(conversation, "title")), if zh { "导出时间（UTC）" } else { "Exported at (UTC)" }, exported,
            if zh { "包含导出时已保存的全部消息和子话题。附件仅含名称及大小，不含附件内容；交互卡片仅含已保存的文本。运行中的回复可能尚未完成。" }
            else { "All saved messages and threads at export time. Attachments include names and sizes, not their contents; interactive cards include saved text only. Running replies may be unfinished." }))?;
        Ok(result)
    }
    fn append(&mut self, value: &str) -> Result<()> {
        if self.content.len().saturating_add(value.len()) > LIMIT {
            return Err(ApiError::new(413, "Conversation export exceeds 10 MiB.")
                .with_code("CONVERSATION_EXPORT_TOO_LARGE"));
        }
        self.content.push_str(value);
        Ok(())
    }
    pub fn push(&mut self, message: &Value, agents: &[Value], file: Option<&Value>) -> Result<()> {
        let role = text(message, "role");
        let author = if role == "assistant" {
            agents
                .iter()
                .find(|a| a["id"] == message["agentId"])
                .and_then(|a| a["name"].as_str())
        } else {
            None
        }
        .or_else(|| message["metadata"]["author"]["name"].as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(match (self.zh, role) {
            (true, "assistant") => "助手",
            (true, "user") => "用户",
            (true, _) => "系统",
            (false, "assistant") => "Assistant",
            (false, "user") => "User",
            (false, _) => "System",
        });
        self.append(&format!(
            "\n---\n\n## {} · {}\n\n",
            line(author),
            line(text(message, "createdAt"))
        ))?;
        for (key, label) in [
            ("id", if self.zh { "消息" } else { "Message" }),
            (
                "threadRootId",
                if self.zh {
                    "子话题根消息"
                } else {
                    "Thread root"
                },
            ),
        ] {
            if let Some(value) = message[key].as_str() {
                self.append(&format!("{label}: {}\n\n", line(value)))?;
            }
        }
        if let Some(value) = message["replyTo"]["id"].as_str() {
            self.append(&format!(
                "{}: {}\n\n",
                if self.zh { "回复消息" } else { "Reply to" },
                line(value)
            ))?;
        }
        let kind = text(message, "kind");
        if !kind.is_empty() && kind != "text" {
            self.append(&format!(
                "{}: {}\n\n",
                if self.zh { "类型" } else { "Type" },
                line(kind)
            ))?;
        }
        for value in [
            message["status"].as_str(),
            message["delivery"]["state"].as_str(),
        ]
        .into_iter()
        .flatten()
        {
            let status = match (self.zh, value) {
                (true, "running") => "进行中",
                (true, "done") => "已完成",
                (true, "error") => "出错",
                (true, "queued") => "排队中",
                (true, "delivered") => "已送达",
                (true, "cancelled") => "已取消",
                (true, "interrupted") => "已中断",
                _ => value,
            };
            self.append(&format!(
                "{}: {}\n\n",
                if self.zh { "状态" } else { "Status" },
                line(status)
            ))?;
        }
        if kind == "file" {
            // Never serialize storage paths, source metadata or credential-bearing URLs.
            let name = file
                .map(|f| text(f, "name"))
                .unwrap_or_else(|| text(message, "content"));
            self.append(&format!(
                "{}: {}",
                if self.zh { "附件" } else { "Attachment" },
                line(basename(name))
            ))?;
            if let Some(size) = file.and_then(|f| f["size"].as_u64()) {
                self.append(&format!(
                    " ({size} {})",
                    if self.zh { "字节" } else { "bytes" }
                ))?;
            }
            if file.is_none() {
                self.append(if self.zh {
                    "（附件已不可用）"
                } else {
                    " (attachment unavailable)"
                })?;
            }
            self.append("\n")?;
            let memo = &message["metadata"]["voiceMemo"];
            if let (Some(transcript), Some(duration)) =
                (memo["transcript"].as_str(), memo["durationMs"].as_u64())
            {
                if transcript.chars().count() <= 500 && (1..=60_000).contains(&duration) {
                    self.append(&format!(
                        "\n{}:\n\n{}\n",
                        if self.zh {
                            "语音文字"
                        } else {
                            "Voice transcript"
                        },
                        transcript
                    ))?;
                }
            }
        } else {
            self.append(text(message, "content"))?;
            self.append("\n")?;
        }
        if kind == "question" {
            let question = &message["metadata"]["question"];
            if let Some(options) = question["options"].as_array().filter(|o| o.len() <= 6) {
                self.append(&format!(
                    "\n{}:\n\n",
                    if self.zh { "选项" } else { "Options" }
                ))?;
                for option in options {
                    if let Some(label) = option["label"]
                        .as_str()
                        .filter(|s| s.chars().count() <= 160)
                    {
                        let selected = question["answer"]["optionIds"]
                            .as_array()
                            .is_some_and(|ids| ids.contains(&option["id"]));
                        self.append(&format!(
                            "- [{}] {}",
                            if selected { "x" } else { " " },
                            line(label)
                        ))?;
                        if let Some(detail) = option["description"]
                            .as_str()
                            .filter(|s| s.chars().count() <= 300)
                        {
                            self.append(&format!(" — {}", line(detail)))?;
                        }
                        self.append("\n")?;
                    }
                }
            }
        }
        if kind == "website_project" {
            let project = &message["metadata"]["websiteProject"];
            if let Some(title) = project["title"]
                .as_str()
                .filter(|s| s.chars().count() <= 100)
            {
                self.append(&format!(
                    "\n{}: {}\n",
                    if self.zh {
                        "网站项目"
                    } else {
                        "Website project"
                    },
                    line(title)
                ))?;
                if let Some(count) = project["fileCount"].as_u64() {
                    self.append(&format!(
                        "{}: {count}\n",
                        if self.zh { "文件数" } else { "Files" }
                    ))?;
                }
            }
        }
        self.count += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_export_fails_without_claiming_a_partial_result() {
        let mut transcript =
            Transcript::new(&serde_json::json!({"title":"Test"}), "now", false).unwrap();
        assert!(transcript.append(&"x".repeat(LIMIT)).is_err());
    }
    #[test]
    fn includes_visible_voice_text_and_question_choices_without_raw_metadata() {
        let mut transcript =
            Transcript::new(&serde_json::json!({"title":"Test"}), "now", false).unwrap();
        transcript.push(&serde_json::json!({"kind":"file","content":"memo.wav","metadata":{"voiceMemo":{"transcript":"Spoken content","durationMs":2000},"secret":"never-export"}}), &[], None).unwrap();
        transcript.push(&serde_json::json!({"kind":"question","content":"Choose","metadata":{"question":{"options":[{"id":"a","label":"Option A","description":"Visible detail"},{"id":"b","label":"Option B"}],"answer":{"optionIds":["b"]},"runId":"never-export"}}}), &[], None).unwrap();
        assert!(
            transcript
                .content
                .contains("Voice transcript:\n\nSpoken content")
        );
        assert!(
            transcript
                .content
                .contains("- [ ] Option A — Visible detail")
        );
        assert!(transcript.content.contains("- [x] Option B"));
        assert!(!transcript.content.contains("never-export"));
    }
}
