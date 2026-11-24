//! Update check: compares the running version with the latest published release.
//!
//! This only *reports* a newer version; installing it is left to the user
//! (the release page has the installers).

use std::time::Duration;

use semver::Version;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::error::{CmdError, CmdResult};

/// Release endpoint returning a GitHub "release" object (`tag_name`, `html_url`, `body`).
/// Override at build time with `TERMINDO_UPDATE_URL`, e.g. for a public releases mirror.
const DEFAULT_UPDATE_URL: &str = "https://api.github.com/repos/bionyxxx/termindo/releases/latest";

fn update_url() -> &'static str {
    match option_env!("TERMINDO_UPDATE_URL") {
        Some(url) if !url.trim().is_empty() => url.trim(),
        _ => DEFAULT_UPDATE_URL,
    }
}

#[derive(Debug, Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub url: String,
    pub notes: Option<String>,
}

/// Parses a release tag such as `v1.2.3` or `1.2.3-beta.1`.
fn parse_tag(tag: &str) -> Option<Version> {
    let tag = tag.trim();
    Version::parse(tag.strip_prefix('v').unwrap_or(tag)).ok()
}

fn is_newer(latest: &Version, current: &Version) -> bool {
    latest > current
}

#[tauri::command]
pub async fn update_check(app: AppHandle) -> CmdResult<UpdateInfo> {
    let current = app.package_info().version.clone();

    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("termindo/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| CmdError::new("internal", e.to_string()))?;
    let res = http
        .get(update_url())
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| CmdError::new("network", format!("could not reach the update server: {e}")))?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(CmdError::not_found("no published release found"));
    }
    if !res.status().is_success() {
        return Err(CmdError::new(
            "server",
            format!("update server returned {}", res.status()),
        ));
    }
    let release: Release = res
        .json()
        .await
        .map_err(|e| CmdError::new("server", format!("invalid release data: {e}")))?;

    let latest = parse_tag(&release.tag_name).ok_or_else(|| {
        CmdError::new(
            "server",
            format!("release tag {:?} is not a version", release.tag_name),
        )
    })?;
    if !release.html_url.starts_with("https://") {
        return Err(CmdError::new("server", "release URL must use https"));
    }
    let available = !release.draft && !release.prerelease && is_newer(&latest, &current);
    tracing::info!(%current, %latest, available, "update check");

    Ok(UpdateInfo {
        current: current.to_string(),
        latest: latest.to_string(),
        available,
        url: release.html_url,
        notes: release.body.filter(|b| !b.trim().is_empty()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn parses_tags() {
        assert_eq!(parse_tag("v0.1.2"), Some(v("0.1.2")));
        assert_eq!(parse_tag("1.0.0-beta.1"), Some(v("1.0.0-beta.1")));
        assert_eq!(parse_tag(" v2.0.0 "), Some(v("2.0.0")));
        assert_eq!(parse_tag("latest"), None);
        assert_eq!(parse_tag("v1.2"), None);
    }

    #[test]
    fn compares_versions() {
        assert!(is_newer(&v("0.1.2"), &v("0.1.1")));
        assert!(is_newer(&v("0.2.0"), &v("0.1.10")));
        assert!(is_newer(&v("0.10.0"), &v("0.9.0")));
        assert!(!is_newer(&v("0.1.1"), &v("0.1.1")));
        assert!(!is_newer(&v("0.1.0"), &v("0.1.1")));
        assert!(!is_newer(&v("1.0.0-rc.1"), &v("1.0.0")));
        assert!(is_newer(&v("1.0.0"), &v("1.0.0-rc.1")));
    }
}
