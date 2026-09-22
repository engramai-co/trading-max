use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Url;

const MAX_BODY: u64 = 65_536;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Remote,
    Demo,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub schema: u8,
    pub mode: Mode,
    pub name: String,
    pub url: String,
    pub auto_connect: bool,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            schema: 1,
            mode: Mode::Remote,
            name: "我的工作台".into(),
            url: String::new(),
            auto_connect: true,
        }
    }
}

pub fn remote_url(input: &str) -> Result<Url, String> {
    let input = input.trim();
    if input.len() > 2048 || input.chars().any(char::is_control) {
        return Err("服务地址过长或包含无效字符。".into());
    }
    let url = Url::parse(input).map_err(|_| "请输入完整的 HTTPS 服务地址。")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("请填写 HTTPS 根地址，不要包含密码、页面路径或查询参数。".into());
    }
    Ok(url)
}

impl Profile {
    pub fn validated(mut self) -> Result<Self, String> {
        if self.schema != 1 {
            return Err("此连接设置来自不兼容的 App 版本。".into());
        }
        self.name = self.name.trim().to_string();
        if self.name.is_empty()
            || self.name.chars().count() > 60
            || self.name.chars().any(char::is_control)
        {
            return Err("请填写 1–60 字的连接名称。".into());
        }
        // Validate even the dormant remote address so secrets cannot be stored in it.
        if !self.url.trim().is_empty() || self.mode == Mode::Remote {
            self.url = remote_url(&self.url)?.to_string();
        }
        Ok(self)
    }
}

pub fn read_profile(root: &Path) -> Result<Option<Profile>, String> {
    let path = root.join("connection.json");
    if !path.exists() {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "无法读取 App 连接设置。")?
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(|_| "无法读取 App 连接设置。")?;
    if bytes.len() > 8192 {
        return Err("App 连接设置过大，请在设置中重新保存。".into());
    }
    let profile: Profile =
        serde_json::from_slice(&bytes).map_err(|_| "App 连接设置损坏，请在设置中重新保存。")?;
    Ok(Some(profile.validated()?))
}

pub fn write_private_json(root: &Path, name: &str, value: &impl Serialize) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|_| "无法创建 App 设置目录。")?;
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))
        .map_err(|_| "无法保护 App 设置目录。")?;
    let temporary = root.join(format!(".{name}.tmp"));
    // Names are internal constants, never supplied by a remote page.
    let bytes = serde_json::to_vec_pretty(value).map_err(|_| "无法编码 App 设置。")?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| "无法写入 App 设置。")?;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| "无法保护 App 设置。")?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "无法保存 App 设置。")?;
    fs::rename(temporary, root.join(name)).map_err(|_| "无法保存 App 设置。")?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Probe {
    pub checked_at_ms: u64,
    pub healthy: bool,
    pub worker_healthy: Option<bool>,
    pub artifact_age_seconds: Option<f64>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn parse_health(bytes: &[u8]) -> Result<Probe, String> {
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| "地址可访问，但没有返回有效的 Trading Max 状态。")?;
    if value["service"] != "trading_max-api"
        || !matches!(value["status"].as_str(), Some("ok" | "degraded"))
    {
        return Err("这个地址没有连接到可识别的 Trading Max 服务。".into());
    }
    Ok(Probe {
        checked_at_ms: now_ms(),
        healthy: value["status"] == "ok",
        worker_healthy: value["worker"]["healthy"].as_bool(),
        artifact_age_seconds: value["artifactAgeSeconds"]
            .as_f64()
            .filter(|x| x.is_finite() && *x >= 0.0),
    })
}

fn probe_endpoint(endpoint: Url) -> Result<Probe, String> {
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Trading-Max-Desktop/1.7.4")
        .build()
        .map_err(|_| "无法初始化安全连接。")?;
    let response = client
        .get(endpoint)
        .header("Accept", "application/json")
        .send()
        .map_err(|error| {
            if error.is_timeout() {
                "连接超时。请确认 Tailscale 已连接，且 Mac mini 在线。".to_string()
            } else {
                "无法建立安全连接。请检查服务地址、Tailscale 和主机状态；证书必须有效。".to_string()
            }
        })?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            301..=399 => "服务重定向到了其他地址。请填写最终的 HTTPS 根地址。".into(),
            401 | 403 => "当前设备没有访问权限，请检查 Tailscale 的访问设置。".into(),
            status => format!("服务返回 HTTP {status}，请稍后重试。"),
        });
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_BODY + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "连接中断，未能读完服务状态。")?;
    if bytes.len() as u64 > MAX_BODY {
        return Err("服务状态响应异常，请检查地址。".into());
    }
    parse_health(&bytes)
}

pub fn probe(profile: &Profile) -> Result<Probe, String> {
    let root = remote_url(&profile.url)?;
    probe_endpoint(
        root.join("api/backend/health")
            .map_err(|_| "服务地址无效。")?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };
    #[test]
    fn only_https_root_without_credentials() {
        assert_eq!(
            remote_url(" https://mini.example.test ").unwrap().as_str(),
            "https://mini.example.test/"
        );
        for address in [
            "http://mini.test",
            "file:///etc/passwd",
            "https://u:p@mini.test",
            "https://mini.test/?key=secret",
            "https://mini.test/#token",
            "https://mini.test/settings",
            "https://mini.test/\nsecret",
        ] {
            assert!(remote_url(address).is_err(), "{address}");
        }
    }
    #[test]
    fn reject_fallback_and_wrong_services() {
        for body in [
            r#"{"status":"local-fallback","service":"trading-max-web"}"#,
            r#"{"status":"ok","service":"other"}"#,
            "not JSON",
            "{}",
        ] {
            assert!(parse_health(body.as_bytes()).is_err());
        }
        let probe = parse_health(br#"{"status":"degraded","service":"trading_max-api","worker":{"healthy":false},"artifactAgeSeconds":120}"#).unwrap();
        assert!(!probe.healthy);
        assert_eq!(probe.worker_healthy, Some(false));
    }
    fn fixture(response: String) -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let count = stream.read(&mut request).unwrap();
            assert!(
                String::from_utf8_lossy(&request[..count]).starts_with("GET /api/backend/health ")
            );
            let _ = stream.write_all(response.as_bytes());
        });
        Url::parse(&format!("http://{address}/api/backend/health")).unwrap()
    }
    #[test]
    fn probe_is_read_only_and_does_not_follow_redirects() {
        let url = fixture("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: 0\r\n\r\n".into());
        assert!(probe_endpoint(url).unwrap_err().contains("重定向"));
        let body = r#"{"status":"ok","service":"trading_max-api","worker":{"healthy":true}}"#;
        let url = fixture(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ));
        assert!(probe_endpoint(url).unwrap().healthy);
    }
    #[test]
    fn oversized_health_response_is_rejected() {
        let body = "x".repeat(MAX_BODY as usize + 1);
        let url = fixture(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ));
        assert!(probe_endpoint(url).unwrap_err().contains("响应异常"));
    }
    #[test]
    fn profiles_roundtrip_privately_and_corruption_is_visible() {
        let root = std::env::temp_dir().join(format!(
            "tm-connection-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let profile = Profile {
            url: "https://mini.example.test/".into(),
            ..Profile::default()
        };
        write_private_json(&root, "connection.json", &profile).unwrap();
        assert_eq!(read_profile(&root).unwrap(), Some(profile));
        assert_eq!(
            fs::metadata(root.join("connection.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        fs::write(root.join("connection.json"), "broken").unwrap();
        assert!(read_profile(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
