use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    fs,
    io::{Read, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::Url;

const MAX_BODY: u64 = 65_536;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug)]
pub struct ProbeError {
    pub message: String,
    pub retryable: bool,
}

impl ProbeError {
    fn permanent(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: false,
        }
    }
    fn transient(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            retryable: true,
        }
    }
}

fn client_with_timeouts(
    connect: Duration,
    request: Duration,
) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(connect)
        .timeout(request)
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Trading-Max-Desktop/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| "无法初始化安全连接。".into())
}

fn client() -> Result<&'static reqwest::blocking::Client, ProbeError> {
    // Health and presentation checks share a bounded pool. A 45-second monitor
    // should not pay for DNS/TCP/TLS again while its connection remains usable.
    static CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| client_with_timeouts(CONNECT_TIMEOUT, REQUEST_TIMEOUT))
        .as_ref()
        .map_err(|message| ProbeError::permanent(message.clone()))
}

fn request_error(error: reqwest::Error) -> ProbeError {
    if error.is_timeout() {
        return ProbeError::transient("连接超时，请检查网络或服务是否在线。");
    }
    let mut source = error.source();
    let mut network_io = false;
    while let Some(cause) = source {
        if let Some(io) = cause.downcast_ref::<std::io::Error>() {
            network_io |= matches!(
                io.kind(),
                std::io::ErrorKind::ConnectionRefused
                    | std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::NotConnected
                    | std::io::ErrorKind::TimedOut
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::UnexpectedEof
                    | std::io::ErrorKind::NetworkUnreachable
                    | std::io::ErrorKind::HostUnreachable
            );
        }
        source = cause.source();
    }
    // Do not treat every is_connect() error as transient: that also includes
    // invalid certificates. System TLS trust is never bypassed for a retry.
    if error.is_dns()
        || network_io
        || (!error.is_connect() && (error.is_request() || error.is_body()))
    {
        ProbeError::transient("连接中断，请检查网络或服务是否在线。")
    } else {
        ProbeError::permanent("无法建立安全连接。请检查服务地址和证书，再手动重试。")
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Remote,
    Demo,
    Local,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub schema: u8,
    pub mode: Mode,
    pub name: String,
    pub url: String,
    pub auto_connect: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<crate::runtime::Workspace>,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            schema: 1,
            mode: Mode::Remote,
            name: "我的工作台".into(),
            url: String::new(),
            auto_connect: true,
            workspace: None,
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
        if self.mode == Mode::Local
            && self
                .workspace
                .as_ref()
                .is_none_or(|w| !w.path.is_absolute())
        {
            return Err("请选择有效的本地工作区。".into());
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

fn probe_endpoint(client: &reqwest::blocking::Client, endpoint: Url) -> Result<Probe, ProbeError> {
    let response = client
        .get(endpoint)
        .header("Accept", "application/json")
        .send()
        .map_err(request_error)?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            301..=399 => {
                ProbeError::permanent("服务重定向到了其他地址。请填写最终的 HTTPS 根地址。")
            }
            401 | 403 => ProbeError::permanent("当前设备没有访问权限，请检查服务的访问设置。"),
            status @ (408 | 425 | 429 | 500..=599) => {
                ProbeError::transient(format!("服务返回 HTTP {status}，请稍后重试。"))
            }
            status => ProbeError::permanent(format!("服务返回 HTTP {status}，请检查服务地址。")),
        });
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_BODY + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ProbeError::transient("连接中断，未能读完服务状态。"))?;
    if bytes.len() as u64 > MAX_BODY {
        return Err(ProbeError::permanent("服务状态响应异常，请检查地址。"));
    }
    parse_health(&bytes).map_err(ProbeError::permanent)
}

pub fn probe(profile: &Profile) -> Result<Probe, ProbeError> {
    let root = remote_url(&profile.url).map_err(ProbeError::permanent)?;
    probe_endpoint(
        client()?,
        root.join("api/backend/health")
            .map_err(|_| ProbeError::permanent("服务地址无效。"))?,
    )
}

pub fn supports_desktop(address: &str) -> bool {
    let Ok(root) = Url::parse(address) else {
        return false;
    };
    let Ok(endpoint) = root.join("/api/desktop") else {
        return false;
    };
    let Ok(client) = client() else {
        return false;
    };
    let Ok(response) = client.get(endpoint).send() else {
        return false;
    };
    if !response.status().is_success() {
        return false;
    }
    let mut bytes = Vec::new();
    if response.take(4097).read_to_end(&mut bytes).is_err() || bytes.len() > 4096 {
        return false;
    }
    desktop_contract(&bytes)
}

fn desktop_contract(bytes: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .is_ok_and(|body| body["service"] == "trading-max-web" && body["desktopPresentation"] == 1)
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
    fn desktop_presentation_requires_a_versioned_service_contract() {
        assert!(desktop_contract(
            br#"{"service":"trading-max-web","desktopPresentation":1}"#
        ));
        for value in [
            r#"{"service":"trading-max-web","desktopPresentation":2}"#,
            r#"{"desktopPresentation":1}"#,
            "<html>old service</html>",
        ] {
            assert!(!desktop_contract(value.as_bytes()));
        }
    }
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
        assert!(probe_endpoint(client().unwrap(), url)
            .unwrap_err()
            .message
            .contains("重定向"));
        let body = r#"{"status":"ok","service":"trading_max-api","worker":{"healthy":true}}"#;
        let url = fixture(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ));
        assert!(probe_endpoint(client().unwrap(), url).unwrap().healthy);
    }
    #[test]
    fn oversized_health_response_is_rejected() {
        let body = "x".repeat(MAX_BODY as usize + 1);
        let url = fixture(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ));
        assert!(probe_endpoint(client().unwrap(), url)
            .unwrap_err()
            .message
            .contains("响应异常"));
    }
    #[test]
    fn retry_only_transient_statuses_and_never_bad_service_contracts() {
        for (status, retryable) in [
            (408, true),
            (429, true),
            (503, true),
            (401, false),
            (403, false),
            (404, false),
            (302, false),
        ] {
            let url = fixture(format!(
                "HTTP/1.1 {status} Test\r\nContent-Length: 0\r\n\r\n"
            ));
            assert_eq!(
                probe_endpoint(client().unwrap(), url)
                    .unwrap_err()
                    .retryable,
                retryable,
                "{status}"
            );
        }
        let body = r#"{"status":"ok","service":"not-trading-max"}"#;
        let url = fixture(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ));
        assert!(
            !probe_endpoint(client().unwrap(), url)
                .unwrap_err()
                .retryable
        );
    }

    #[test]
    fn health_and_presentation_reuse_one_connection_even_with_a_slow_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let root = format!("http://{}/", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(35)))
                .unwrap();
            for (path, body, delay) in [
                (
                    "/api/backend/health",
                    r#"{"status":"ok","service":"trading_max-api"}"#,
                    11,
                ),
                (
                    "/api/desktop",
                    r#"{"service":"trading-max-web","desktopPresentation":1}"#,
                    4,
                ),
            ] {
                let mut bytes = [0; 4096];
                let length = stream.read(&mut bytes).unwrap();
                assert!(
                    String::from_utf8_lossy(&bytes[..length]).starts_with(&format!("GET {path} "))
                );
                thread::sleep(Duration::from_secs(delay));
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        // Both delays exceed their former deadlines (10s health, 3s metadata).
        let url = Url::parse(&format!("{root}api/backend/health")).unwrap();
        assert!(probe_endpoint(client().unwrap(), url).unwrap().healthy);
        assert!(supports_desktop(&root));
        server.join().unwrap();
    }

    #[test]
    fn stalled_headers_and_body_are_bounded_and_retryable() {
        for headers_first in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = Url::parse(&format!(
                "http://{}/api/backend/health",
                listener.local_addr().unwrap()
            ))
            .unwrap();
            let server = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                assert!(stream.read(&mut request).unwrap() > 0);
                if headers_first {
                    write!(stream, "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n").unwrap();
                }
                thread::sleep(Duration::from_millis(400));
            });
            let client =
                client_with_timeouts(Duration::from_millis(100), Duration::from_millis(150))
                    .unwrap();
            let start = std::time::Instant::now();
            assert!(probe_endpoint(&client, url).unwrap_err().retryable);
            assert!(start.elapsed() < Duration::from_millis(1500));
            server.join().unwrap();
        }
    }

    #[test]
    fn tls_failures_are_not_bypassed_or_retried_as_plain_http() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = Url::parse(&format!(
            "https://{}/api/backend/health",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            assert!(stream.read(&mut request).unwrap() > 0);
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
        });
        let error = probe_endpoint(client().unwrap(), endpoint).unwrap_err();
        assert!(!error.retryable);
        assert!(error.message.contains("安全连接"));
        server.join().unwrap();
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
