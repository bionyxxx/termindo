//! Snippet placeholders: `{{name}}` tokens substituted before execution.
//!
//! Built-in variables (filled from the target session): `host`, `hostname`,
//! `port`, `user`, `label`. Any other name is prompted for in the UI.

use std::collections::{BTreeSet, HashMap};

pub const BUILTIN_VARS: &[&str] = &["host", "hostname", "port", "user", "label"];

/// Distinct placeholder names in order of first appearance.
pub fn placeholders(body: &str) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(start) = rest.find("{{") {
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else { break };
        let name = after[..end].trim();
        if is_valid_name(name) && seen.insert(name.to_string()) {
            out.push(name.to_string());
        }
        rest = &after[end + 2..];
    }
    out
}

/// Placeholders that are not built-ins (the UI must prompt for them).
pub fn custom_placeholders(body: &str) -> Vec<String> {
    placeholders(body)
        .into_iter()
        .filter(|p| !BUILTIN_VARS.contains(&p.as_str()))
        .collect()
}

fn is_valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// Substitute `{{name}}` tokens. Unknown tokens are left untouched.
pub fn render(body: &str, vars: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let name = after[..end].trim();
                match vars.get(name) {
                    Some(v) if is_valid_name(name) => out.push_str(v),
                    _ => {
                        out.push_str("{{");
                        out.push_str(&after[..end]);
                        out.push_str("}}");
                    }
                }
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_and_renders() {
        let body = "ssh {{ user }}@{{host}} -p {{port}} && echo {{msg}} {{host}} {{unknown}";
        assert_eq!(placeholders(body), vec!["user", "host", "port", "msg"]);
        assert_eq!(custom_placeholders(body), vec!["msg"]);
        let vars: HashMap<String, String> = [
            ("user", "root"),
            ("host", "h"),
            ("port", "22"),
            ("msg", "hi"),
        ]
        .into_iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
        assert_eq!(
            render(body, &vars),
            "ssh root@h -p 22 && echo hi h {{unknown}"
        );
        assert_eq!(render("{{nope}} x", &vars), "{{nope}} x");
    }
}
