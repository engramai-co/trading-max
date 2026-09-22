use serde::{Deserialize, Serialize};
use std::{io::Read, time::Duration};

const ENDPOINT: &str = "https://api.github.com/repos/engramai-co/trading-max/releases/latest";
const MAX_BODY: u64 = 262_144;

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

#[derive(Serialize)]
pub struct UpdateCheck {
    pub version: String,
    pub relation: &'static str,
    pub checked_at_ms: u64,
}

fn version(value: &str) -> Result<[u32; 3], String> {
    let parts: Vec<_> = value
        .strip_prefix('v')
        .unwrap_or(value)
        .split('.')
        .collect();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || !part.bytes().all(|b| b.is_ascii_digit())
                || (part.len() > 1 && part.starts_with('0'))
        })
    {
        return Err("版本信息无法识别，请稍后重试。".into());
    }
    let mut result = [0; 3];
    for (index, part) in parts.iter().enumerate() {
        result[index] = part.parse().map_err(|_| "版本信息无法识别，请稍后重试。")?;
    }
    Ok(result)
}

pub fn notes_url(value: &str) -> Result<tauri::Url, String> {
    let [major, minor, patch] = version(value)?;
    format!("https://github.com/engramai-co/trading-max/releases/tag/v{major}.{minor}.{patch}")
        .parse()
        .map_err(|_| "无法打开版本说明。".into())
}

fn parse_release(bytes: &[u8], installed: &str) -> Result<UpdateCheck, String> {
    let release: Release =
        serde_json::from_slice(bytes).map_err(|_| "版本服务返回的信息不完整。")?;
    if release.draft || release.prerelease {
        return Err("暂时没有可核对的稳定版本。".into());
    }
    let available = version(&release.tag_name)?;
    let current = version(installed)?;
    Ok(UpdateCheck {
        version: release.tag_name.trim_start_matches('v').into(),
        relation: match available.cmp(&current) {
            std::cmp::Ordering::Greater => "newer",
            std::cmp::Ordering::Equal => "same",
            std::cmp::Ordering::Less => "older",
        },
        checked_at_ms: crate::connection::now_ms(),
    })
}

pub fn check() -> Result<UpdateCheck, String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Trading-Max-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "无法初始化版本检查。")?;
    let response = client
        .get(ENDPOINT)
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|_| "暂时无法连接版本服务。你可以继续使用 App，稍后再试。")?;
    if !response.status().is_success() {
        return Err(
            if response.status().as_u16() == 403 || response.status().as_u16() == 429 {
                "版本服务暂时限流，请稍后重试。"
            } else {
                "暂时未能检查版本。你可以继续使用 App，稍后再试。"
            }
            .into(),
        );
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_BODY + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "版本检查未完成，请重试。")?;
    if bytes.len() as u64 > MAX_BODY {
        return Err("版本信息过大，请稍后重试。".into());
    }
    parse_release(&bytes, env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_numeric_versions_without_claiming_a_desktop_download() {
        for (tag, expected) in [
            ("v1.10.0", "newer"),
            ("v1.8.0", "same"),
            ("v1.7.9", "older"),
        ] {
            let result = parse_release(
                format!(r#"{{"tag_name":"{tag}","draft":false,"prerelease":false}}"#).as_bytes(),
                "1.8.0",
            )
            .unwrap();
            assert_eq!(result.relation, expected);
        }
    }

    #[test]
    fn untrusted_release_metadata_cannot_choose_a_download_or_origin() {
        for tag in [
            "../evil",
            "1.8.0?key=x",
            "v1.8.0-rc.1",
            "1.08.0",
            "https://evil.test/",
            "+1.8.0",
        ] {
            assert!(notes_url(tag).is_err());
        }
        assert_eq!(
            notes_url("v1.8.0").unwrap().as_str(),
            "https://github.com/engramai-co/trading-max/releases/tag/v1.8.0"
        );
        for bytes in [
            br#"{"tag_name":"v1.8.0","draft":true,"prerelease":false}"#.as_slice(),
            br#"{"tag_name":"v1.8.0","draft":false,"prerelease":true}"#,
            b"{}",
        ] {
            assert!(parse_release(bytes, "1.8.0").is_err());
        }
    }
}
