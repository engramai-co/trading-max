//! Official release checks. Only validated metadata can select an in-app update feed.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Read, time::Duration};

const API: &str = "https://api.github.com/repos/engramai-co/trading-max/releases";
const ORIGIN: &str = "https://github.com/engramai-co/trading-max/releases";
const MAX_BODY: u64 = 1_048_576;
const MAX_MANIFEST: u64 = 16_384;
// Public identity of the owner's existing Apple Developer organization.
const TEAM: &str = "H757XFW8A9";
const BUNDLE: &str = "com.engram.trading-max.desktop-preview";
const TARGET: &str = "macos-arm64";

#[derive(Clone, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
    state: String,
    digest: Option<String>,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Manifest {
    schema: u32,
    version: String,
    target: String,
    bundle_id: String,
    team_id: String,
    signing: String,
    notarized: bool,
    minimum_macos: String,
    asset: ManifestAsset,
}
#[derive(Deserialize)]
struct ManifestAsset {
    name: String,
    size: u64,
    sha256: String,
}

#[derive(Serialize)]
pub struct DesktopRelease {
    pub version: String,
    pub relation: &'static str,
    pub size: u64,
    pub sha256: String,
    pub in_app: bool,
}
pub struct UpdateFeed {
    pub url: String,
    pub version: String,
    pub archive: String,
    pub size: u64,
}
#[derive(Serialize)]
pub struct UpdateCheck {
    pub version: String,
    pub desktop: Option<DesktopRelease>,
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
fn normalized(value: &str) -> Result<String, String> {
    let [a, b, c] = version(value)?;
    Ok(format!("{a}.{b}.{c}"))
}
pub fn notes_url(value: &str) -> Result<tauri::Url, String> {
    format!("{ORIGIN}/tag/v{}", normalized(value)?)
        .parse()
        .map_err(|_| "无法打开版本说明。".into())
}
fn asset_name(value: &str, extension: &str) -> String {
    format!("trading-max-v{value}-{TARGET}.{extension}")
}
fn asset_url(value: &str, extension: &str) -> String {
    format!(
        "{ORIGIN}/download/v{value}/{}",
        asset_name(value, extension)
    )
}
fn digest(asset: &Asset) -> Result<&str, String> {
    asset
        .digest
        .as_deref()
        .and_then(|d| d.strip_prefix("sha256:"))
        .filter(|d| {
            d.len() == 64
                && d.bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
        .ok_or_else(|| "安装包的校验信息尚未就绪，请稍后重试。".into())
}
fn asset(release: &Release, value: &str, extension: &str) -> Result<Option<Asset>, String> {
    let matches: Vec<_> = release
        .assets
        .iter()
        .filter(|a| a.name == asset_name(value, extension))
        .collect();
    if matches.is_empty() {
        return Ok(None);
    }
    if matches.len() != 1 {
        return Err("安装包发布信息重复，请稍后重试。".into());
    }
    let item = matches[0];
    let limit = if matches!(extension, "json" | "xml") {
        MAX_MANIFEST
    } else {
        2_147_483_648
    };
    if item.state != "uploaded"
        || item.size == 0
        || item.size > limit
        || item.browser_download_url != asset_url(value, extension)
    {
        return Err("安装包发布信息不完整或来源不匹配，未打开下载。".into());
    }
    digest(item)?;
    Ok(Some(item.clone()))
}
fn package(release: &Release) -> Result<Option<(String, Asset, Asset)>, String> {
    if release.draft || release.prerelease {
        return Ok(None);
    }
    let value = normalized(&release.tag_name)?;
    if release.tag_name != format!("v{value}") {
        return Ok(None);
    }
    let dmg = asset(release, &value, "dmg")?;
    let manifest = asset(release, &value, "json")?;
    Ok(dmg.zip(manifest).map(|(d, m)| (value, d, m)))
}
fn validate_manifest(
    bytes: &[u8],
    value: &str,
    dmg: &Asset,
    metadata: &Asset,
    installed: &str,
) -> Result<DesktopRelease, String> {
    if bytes.len() as u64 != metadata.size
        || format!("{:x}", Sha256::digest(bytes)) != digest(metadata)?
    {
        return Err("安装包发布说明校验失败，未打开下载。".into());
    }
    let m: Manifest = serde_json::from_slice(bytes).map_err(|_| "安装包发布说明无法读取。")?;
    if m.schema != 1
        || m.version != value
        || m.target != TARGET
        || m.bundle_id != BUNDLE
        || m.team_id != TEAM
        || m.signing != "Developer ID Application"
        || !m.notarized
        || m.minimum_macos != "13.0"
        || m.asset.name != dmg.name
        || m.asset.size != dmg.size
        || m.asset.sha256 != digest(dmg)?
    {
        return Err("安装包版本、发布者或校验信息不匹配，未打开下载。".into());
    }
    Ok(DesktopRelease {
        version: value.into(),
        size: dmg.size,
        sha256: m.asset.sha256,
        in_app: false,
        relation: match version(value)?.cmp(&version(installed)?) {
            std::cmp::Ordering::Greater => "newer",
            std::cmp::Ordering::Equal => "same",
            std::cmp::Ordering::Less => "older",
        },
    })
}
fn release_redirect(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.host_str() == Some("release-assets.githubusercontent.com")
}
fn request(url: &str, limit: u64, redirects: bool) -> Result<Vec<u8>, String> {
    let policy = if redirects {
        reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() <= 3 && release_redirect(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("unexpected release redirect")
            }
        })
    } else {
        reqwest::redirect::Policy::none()
    };
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .redirect(policy)
        .user_agent(concat!("Trading-Max-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "无法初始化版本检查。")?;
    let response = client
        .get(url)
        .header(
            "Accept",
            if redirects {
                "application/octet-stream"
            } else {
                "application/vnd.github+json"
            },
        )
        .send()
        .map_err(|_| "暂时无法连接版本服务。你可以继续使用 App，稍后再试。")?;
    if !response.status().is_success() {
        return Err(if matches!(response.status().as_u16(), 403 | 429) {
            "版本服务暂时限流，请稍后重试。"
        } else {
            "暂时未能检查版本。你可以继续使用 App，稍后再试。"
        }
        .into());
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "版本检查未完成，请重试。")?;
    if bytes.len() as u64 > limit {
        return Err("版本信息过大，请稍后重试。".into());
    }
    Ok(bytes)
}
fn checked_package(release: &Release, installed: &str) -> Result<Option<DesktopRelease>, String> {
    let Some((value, dmg, metadata)) = package(release)? else {
        return Ok(None);
    };
    let bytes = request(&metadata.browser_download_url, MAX_MANIFEST, true)?;
    let mut checked = validate_manifest(&bytes, &value, &dmg, &metadata, installed)?;
    checked.in_app = checked.relation == "newer" && asset(release, &value, "xml")?.is_some();
    Ok(Some(checked))
}
fn stable_releases(bytes: &[u8]) -> Result<Vec<Release>, String> {
    let mut releases: Vec<Release> =
        serde_json::from_slice(bytes).map_err(|_| "版本服务返回的信息不完整。")?;
    releases.retain(|r| !r.draft && !r.prerelease && version(&r.tag_name).is_ok());
    releases.sort_by_key(|r| std::cmp::Reverse(version(&r.tag_name).unwrap()));
    if releases.is_empty() {
        return Err("暂时没有可核对的稳定版本。".into());
    }
    Ok(releases)
}
pub fn check() -> Result<UpdateCheck, String> {
    let releases = stable_releases(&request(&format!("{API}?per_page=30"), MAX_BODY, false)?)?;
    let mut desktop = None;
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        for release in &releases {
            if let Some(checked) = checked_package(release, env!("CARGO_PKG_VERSION"))? {
                desktop = Some(checked);
                break;
            }
        }
    }
    Ok(UpdateCheck {
        version: normalized(&releases[0].tag_name)?,
        desktop,
        checked_at_ms: crate::connection::now_ms(),
    })
}
/// Recheck the exact release when clicked. Never accept a renderer-supplied URL/hash.
pub fn download_url(value: &str) -> Result<tauri::Url, String> {
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err("当前安装包仅支持 Apple Silicon Mac。".into());
    }
    let value = normalized(value)?;
    if version(&value)? < version(env!("CARGO_PKG_VERSION"))? {
        return Err("此版本早于本机 App，未打开降级下载。".into());
    }
    let bytes = request(&format!("{API}/tags/v{value}"), MAX_BODY, false)?;
    let release: Release =
        serde_json::from_slice(&bytes).map_err(|_| "版本服务返回的信息不完整。")?;
    if release.tag_name != format!("v{value}")
        || checked_package(&release, env!("CARGO_PKG_VERSION"))?.is_none()
    {
        return Err("这个版本还没有可下载的正式桌面安装包。".into());
    }
    asset_url(&value, "dmg")
        .parse()
        .map_err(|_| "无法打开安装包下载。".into())
}

pub fn update_feed(value: &str) -> Result<UpdateFeed, String> {
    let value = normalized(value)?;
    if !cfg!(all(target_os = "macos", target_arch = "aarch64"))
        || version(&value)? <= version(env!("CARGO_PKG_VERSION"))?
    {
        return Err("App 内更新只支持更新的 Apple Silicon 版本。".into());
    }
    let bytes = request(&format!("{API}/tags/v{value}"), MAX_BODY, false)?;
    let release: Release = serde_json::from_slice(&bytes).map_err(|_| "更新发布信息无法读取。")?;
    let checked = checked_package(&release, env!("CARGO_PKG_VERSION"))?
        .filter(|p| p.in_app && p.version == value)
        .ok_or("这个版本尚未提供可验证的 App 内更新，请使用官方安装包。")?;
    Ok(UpdateFeed {
        url: asset_url(&value, "xml"),
        archive: asset_url(&value, "dmg"),
        version: value,
        size: checked.size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn fixture() -> (Release, Vec<u8>) {
        let v = "1.11.0";
        let dmg = Asset {
            name: asset_name(v, "dmg"),
            browser_download_url: asset_url(v, "dmg"),
            size: 12345678,
            state: "uploaded".into(),
            digest: Some(format!("sha256:{}", "a".repeat(64))),
        };
        let bytes = serde_json::to_vec(&json!({"schema":1,"version":v,"target":TARGET,"bundle_id":BUNDLE,"team_id":TEAM,"signing":"Developer ID Application","notarized":true,"minimum_macos":"13.0","asset":{"name":dmg.name,"size":dmg.size,"sha256":"a".repeat(64)}})).unwrap();
        let metadata = Asset {
            name: asset_name(v, "json"),
            browser_download_url: asset_url(v, "json"),
            size: bytes.len() as u64,
            state: "uploaded".into(),
            digest: Some(format!("sha256:{:x}", Sha256::digest(&bytes))),
        };
        (
            Release {
                tag_name: format!("v{v}"),
                draft: false,
                prerelease: false,
                assets: vec![dmg, metadata],
            },
            bytes,
        )
    }
    #[test]
    fn source_only_and_desktop_versions_are_separate() {
        let releases = stable_releases(br#"[{"tag_name":"v1.12.0","draft":false,"prerelease":false},{"tag_name":"v1.11.0","draft":false,"prerelease":false},{"tag_name":"v9.0.0","draft":false,"prerelease":true}]"#).unwrap();
        assert_eq!(releases.len(), 2);
        assert_eq!(releases[0].tag_name, "v1.12.0");
        assert!(package(&releases[0]).unwrap().is_none());
        let (r, bytes) = fixture();
        let (v, d, m) = package(&r).unwrap().unwrap();
        for (installed, relation) in [("1.10.9", "newer"), ("1.11.0", "same"), ("1.12.0", "older")]
        {
            assert_eq!(
                validate_manifest(&bytes, &v, &d, &m, installed)
                    .unwrap()
                    .relation,
                relation
            );
        }
    }
    #[test]
    fn refuses_untrusted_incomplete_or_ambiguous_assets() {
        for bad in [
            "https://evil.test/download",
            "http://github.com/a.dmg",
            "https://github.com/other/repo/releases/download/v1.11.0/a.dmg",
        ] {
            let (mut r, _) = fixture();
            r.assets[0].browser_download_url = bad.into();
            assert!(package(&r).is_err());
        }
        let (mut r, _) = fixture();
        r.assets[0].digest = None;
        assert!(package(&r).is_err());
        let (mut r, _) = fixture();
        r.assets[0].state = "new".into();
        assert!(package(&r).is_err());
        let (mut r, _) = fixture();
        r.assets.push(r.assets[0].clone());
        assert!(package(&r).is_err());
        let (mut r, _) = fixture();
        r.assets.pop();
        assert!(package(&r).unwrap().is_none());
        let (mut r, _) = fixture();
        r.draft = true;
        assert!(package(&r).unwrap().is_none());
    }
    #[test]
    fn rejects_corrupt_metadata_wrong_publisher_or_platform() {
        let (r, bytes) = fixture();
        let (v, d, mut m) = package(&r).unwrap().unwrap();
        assert!(validate_manifest(b"{}", &v, &d, &m, "1.10.0").is_err());
        for (key, bad) in [
            ("team_id", json!("OTHERTEAM1")),
            ("bundle_id", json!("other.app")),
            ("version", json!("1.10.0")),
            ("target", json!("macos-x64")),
            ("notarized", json!(false)),
            ("minimum_macos", json!("14.0")),
        ] {
            let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            value[key] = bad;
            let changed = serde_json::to_vec(&value).unwrap();
            m.size = changed.len() as u64;
            m.digest = Some(format!("sha256:{:x}", Sha256::digest(&changed)));
            assert!(validate_manifest(&changed, &v, &d, &m, "1.10.0").is_err());
        }
    }
    #[test]
    fn versions_and_redirects_cannot_choose_an_arbitrary_origin() {
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
        for url in [
            "http://release-assets.githubusercontent.com/a",
            "https://release-assets.githubusercontent.com.evil.test/a",
            "https://u:p@release-assets.githubusercontent.com/a",
            "https://release-assets.githubusercontent.com:444/a",
            "https://127.0.0.1/a",
        ] {
            assert!(!release_redirect(&url.parse().unwrap()));
        }
        assert!(release_redirect(
            &"https://release-assets.githubusercontent.com/a?token=temporary"
                .parse()
                .unwrap()
        ));
    }
    #[test]
    fn appcast_asset_must_be_unique_bounded_and_official() {
        let (mut release, _) = fixture();
        assert!(asset(&release, "1.11.0", "xml").unwrap().is_none());
        release.assets.push(Asset {
            name: asset_name("1.11.0", "xml"),
            browser_download_url: asset_url("1.11.0", "xml"),
            size: 1024,
            state: "uploaded".into(),
            digest: Some(format!("sha256:{}", "a".repeat(64))),
        });
        assert!(asset(&release, "1.11.0", "xml").unwrap().is_some());
        release.assets.last_mut().unwrap().size = MAX_MANIFEST + 1;
        assert!(asset(&release, "1.11.0", "xml").is_err());
        release.assets.last_mut().unwrap().size = 1024;
        release.assets.last_mut().unwrap().browser_download_url =
            "https://example.com/feed.xml".into();
        assert!(asset(&release, "1.11.0", "xml").is_err());
        release.assets.last_mut().unwrap().browser_download_url = asset_url("1.11.0", "xml");
        release.assets.push(release.assets.last().unwrap().clone());
        assert!(asset(&release, "1.11.0", "xml").is_err());
    }
}
