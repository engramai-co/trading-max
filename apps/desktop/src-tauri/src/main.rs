#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod connection;
mod recovery;
mod runtime;
mod sparkle;
mod surfaces;
mod updates;

use connection::{Mode, Probe, Profile};
use runtime::{Runtime, Workspace};
use serde::{Deserialize, Serialize};
use std::{
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{MenuBuilder, MenuItem, SubmenuBuilder},
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_dialog::DialogExt;

// The workspace page sits under a transparent title bar. Native code owns the
// top band for dragging; the page only learns that it should leave it empty.
const WORKSPACE_CHROME_BAND: f64 = 28.0;
const WORKSPACE_CHROME_SCRIPT: &str = r#"(function () {
  var mark = function () {
    var root = document.documentElement;
    if (root) root.dataset.desktopChrome = "overlay";
    return Boolean(root);
  };
  if (!mark()) new MutationObserver(function (_, observer) { if (mark()) observer.disconnect(); })
    .observe(document, { childList: true });
})();"#;
#[cfg(target_os = "macos")]
extern "C" {
    fn trading_max_install_drag_strip(window: *mut std::ffi::c_void, height: f64);
    fn trading_max_set_connection_notice(
        window: *mut std::ffi::c_void,
        message: *const std::ffi::c_char,
    );
}

#[derive(Clone, Serialize)]
struct Session {
    app_version: &'static str,
    profile: Profile,
    workspaces: Vec<Workspace>,
    generation: u64,
    stage: String,
    message: String,
    detail: String,
    active_url: Option<String>,
    active_name: Option<String>,
    probe: Option<Probe>,
    desktop_presentation: bool,
    retry_at_ms: Option<u64>,
    #[serde(skip)]
    desired: Option<Profile>,
    #[serde(skip)]
    dismiss_settings: bool,
}
impl Session {
    fn workspace_available(&self) -> bool {
        self.active_url.is_some()
            && matches!(self.stage.as_str(), "ready" | "reconnecting" | "offline")
    }

    fn remote_failed(&mut self, error: connection::ProbeError, after: Option<Duration>) {
        let retained = self.workspace_available();
        self.stage = if retained {
            if after.is_some() {
                "reconnecting"
            } else {
                "offline"
            }
        } else {
            "error"
        }
        .into();
        self.message = if retained {
            "连接中断，当前页面已保留。"
        } else {
            "暂时无法连接这份资料。"
        }
        .into();
        self.detail = error.message;
        self.probe = None; // A previous healthy check is not current availability.
        self.retry_at_ms = after.map(|delay| connection::now_ms() + delay.as_millis() as u64);
        if !retained {
            self.active_url = None;
            self.active_name = None;
        }
    }

    /// True only when there is no retained/in-flight page to return to.
    fn remote_recovered(&mut self, probe: Probe) -> bool {
        let enter = self.active_url.is_none();
        if self.workspace_available() {
            self.stage = "ready".into();
            self.message = format!("已连接{}", self.active_name.as_deref().unwrap_or("资料库"));
        }
        self.probe = Some(probe);
        self.detail.clear();
        self.retry_at_ms = None;
        enter
    }
}
struct Desktop {
    root: PathBuf,
    runtime: Runtime,
    session: Mutex<Session>,
    exiting: AtomicBool,
}
impl Desktop {
    fn snapshot(&self) -> Session {
        self.session.lock().unwrap().clone()
    }
    fn update(&self, generation: u64, update: impl FnOnce(&mut Session)) -> bool {
        let mut session = self.session.lock().unwrap();
        if session.generation != generation || self.exiting.load(Ordering::Relaxed) {
            return false;
        }
        update(&mut session);
        // No account payload, broker secret or API token is written here.
        let _ = connection::write_private_json(&self.root, "connection-status.json", &*session);
        true
    }
    fn request(
        &self,
        profile: Option<Profile>,
        save: bool,
        dismiss_settings: bool,
    ) -> Result<u64, String> {
        let mut session = self.session.lock().unwrap();
        if let Some(profile) = &profile {
            if save {
                connection::write_private_json(&self.root, "connection.json", profile)?;
            }
            session.profile = profile.clone();
        }
        session.generation += 1;
        session.desired = profile;
        session.dismiss_settings = dismiss_settings;
        session.active_url = None;
        session.active_name = None;
        session.probe = None;
        session.desktop_presentation = false;
        session.retry_at_ms = None;
        session.stage = if session.desired.is_some() {
            "connecting"
        } else {
            "idle"
        }
        .into();
        session.message = match &session.desired {
            Some(p) if p.mode == Mode::Remote => format!("正在连接{}…", p.name),
            Some(p) if p.mode == Mode::Local => format!("正在打开{}…", p.name),
            Some(_) => "正在打开本机演示…".into(),
            None => "选择你的数据来源。".into(),
        };
        session.detail.clear();
        let _ = connection::write_private_json(&self.root, "connection-status.json", &*session);
        Ok(session.generation)
    }
}
fn internal_url(url: &tauri::Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost")
}
fn workspace_url(url: &tauri::Url, base: Option<&str>) -> bool {
    base.and_then(|value| tauri::Url::parse(value).ok())
        .is_some_and(|root| {
            url.origin() == root.origin()
                && match root.scheme() {
                    "https" => true,
                    "http" => root.host_str() == Some("127.0.0.1"),
                    _ => false,
                }
        })
}
fn native_surface(label: &str, url: &tauri::Url) -> bool {
    matches!(label, "main" | "settings" | "workspaces") && internal_url(url)
}
fn local_command(window: &WebviewWindow) -> Result<(), String> {
    if window
        .url()
        .is_ok_and(|url| native_surface(window.label(), &url))
    {
        Ok(())
    } else {
        Err("原生设置仅供 App 本机界面使用。".into())
    }
}
fn open_external(url: &tauri::Url) {
    if matches!(url.scheme(), "https" | "http")
        && url.username().is_empty()
        && url.password().is_none()
    {
        let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
    }
}
fn reveal_window(window: &WebviewWindow) -> tauri::Result<()> {
    // A background launch can leave the application hidden even when its
    // NSWindow is visible. Unhide the application before focusing the webview.
    #[cfg(target_os = "macos")]
    window.app_handle().show()?;
    window.unminimize()?;
    window.show()?;
    fit_webview(window)?;
    window.set_focus()
}
fn fit_webview(window: &WebviewWindow) -> tauri::Result<()> {
    // Showing an NSWindow does not necessarily update its WKWebView frame
    // after a hidden/background transition. Explicitly lay out and reveal the
    // content view as well; no script or native capability is sent to the page.
    let webview: &tauri::Webview = window.as_ref();
    webview.set_bounds(tauri::Rect {
        position: tauri::PhysicalPosition::new(0, 0).into(),
        size: window.inner_size()?.into(),
    })?;
    webview.show()
}
fn settings_visible(app: &tauri::AppHandle) -> bool {
    ["settings", "workspaces"].iter().any(|label| {
        app.get_webview_window(label)
            .is_some_and(|window| window.is_visible().unwrap_or(false))
    })
}
fn home(app: &tauri::AppHandle, desktop: &Arc<Desktop>, generation: u64) {
    let app = app.clone();
    let desktop = desktop.clone();
    let handle = app.clone();
    let _ = handle.run_on_main_thread(move || {
        if desktop.snapshot().generation != generation {
            return;
        }
        // Keep the bundled entry alive independently of a failed HTTP WebView.
        // Returning a used WKWebView from HTTP to the custom scheme can go blank.
        surfaces::close(&app);
        if let Some(workspace) = app.get_webview_window("workspace") {
            let _ = workspace.hide();
        }
        if let Some(window) = app.get_webview_window("main") {
            if settings_visible(&app) {
                let _ = window.show();
            } else {
                let _ = reveal_window(&window);
            }
        }
    });
}
fn connection_notice(app: &tauri::AppHandle, desktop: &Arc<Desktop>, generation: u64) {
    let handle = app.clone();
    let desktop = desktop.clone();
    let _ = app.run_on_main_thread(move || {
        let snapshot = desktop.snapshot();
        if snapshot.generation != generation {
            return;
        }
        if let Some(window) = handle.get_webview_window("workspace") {
            #[cfg(target_os = "macos")]
            if let Ok(native) = window.ns_window() {
                let message = match snapshot.stage.as_str() {
                    "reconnecting" => "连接中断 · 正在重连，数据可能未更新",
                    "offline" => "连接中断 · 数据可能未更新，请在「连接」菜单重试",
                    _ => "",
                };
                let message = std::ffi::CString::new(message).unwrap();
                // AppKit-only status in the existing title band, no remote IPC
                // or injected account data, and no overlay on the portfolio.
                unsafe { trading_max_set_connection_notice(native, message.as_ptr()) };
            }
        }
    });
}
fn enter(
    app: &tauri::AppHandle,
    desktop: &Arc<Desktop>,
    generation: u64,
    address: String,
    name: String,
) {
    // This runs on the connection driver, never on the UI thread. Unsupported
    // services remain compatible; only an explicit versioned contract opts in.
    let presentation = connection::supports_desktop(&address);
    let app = app.clone();
    let desktop = desktop.clone();
    let handle = app.clone();
    let _ = handle.run_on_main_thread(move || {
        if desktop.snapshot().generation != generation {
            return;
        }
        let Ok(mut url) = tauri::Url::parse(&address) else {
            return;
        };
        if presentation {
            url = surfaces::presentation_url(url);
        }
        let dismiss_settings = desktop.snapshot().dismiss_settings;
        desktop.update(generation, |session| {
            session.active_url = Some(address);
            session.desktop_presentation = presentation;
            session.active_name = Some(name.clone());
            session.stage = "loading".into();
            session.message = format!("正在打开{name}…");
            session.detail.clear();
        });
        let focus = dismiss_settings || !settings_visible(&app);
        let result = match app.get_webview_window("workspace") {
            Some(window) => {
                // home() hides the previous workspace while services switch.
                // Make WKWebView visible before navigation so its first paint
                // is not suspended until a resize or manual reload.
                window
                    .show()
                    .and_then(|_| window.navigate(url))
                    .map(|_| window)
            }
            None => create_workspace_window(&app, &desktop, url, focus),
        };
        match result {
            Err(error) => failed(&app, &desktop, generation, error.to_string()),
            Ok(window) => {
                connection_notice(&app, &desktop, generation);
                let _ = window.set_title(&format!("Trading Max · {name}"));
                if dismiss_settings {
                    for label in ["settings", "workspaces"] {
                        if let Some(settings) = app.get_webview_window(label) {
                            // Retain the settings WKWebView while the new workspace
                            // begins loading. Destroying it here can suspend the
                            // replacement page before its first visible frame.
                            let _ = settings.hide();
                        }
                    }
                }
                if focus {
                    let _ = reveal_window(&window);
                } else {
                    let _ = window.show();
                }
                if let Some(entry) = app.get_webview_window("main") {
                    let _ = entry.hide();
                }
            }
        }
    });
}
fn create_workspace_window(
    app: &tauri::AppHandle,
    desktop: &Arc<Desktop>,
    url: tauri::Url,
    focus: bool,
) -> tauri::Result<WebviewWindow> {
    let navigation = desktop.clone();
    let pages = desktop.clone();
    let links = desktop.clone();
    let handle = app.clone();
    let builder = WebviewWindowBuilder::new(app, "workspace", WebviewUrl::External(url))
        .title("Trading Max")
        .inner_size(1280.0, 840.0)
        .min_inner_size(900.0, 640.0)
        .center()
        .visible(true)
        .focused(focus)
        .initialization_script(WORKSPACE_CHROME_SCRIPT);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder
        // Keep progress and recovery responsive across native window switches;
        // WKWebView's default suspend policy can freeze a newly opened page.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |url| {
            if workspace_url(url, navigation.snapshot().active_url.as_deref()) {
                return true;
            }
            open_external(url);
            false
        })
        .on_new_window(move |url, _| {
            surfaces::follow_link(&handle, &links, links.snapshot().generation, url);
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(move |window, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            let snapshot = pages.snapshot();
            if workspace_url(payload.url(), snapshot.active_url.as_deref()) {
                let _ = fit_webview(&window);
                pages.update(snapshot.generation, |session| {
                    // A page finish cannot erase a failed health check.
                    if !matches!(session.stage.as_str(), "reconnecting" | "offline") {
                        session.stage = "ready".into();
                        session.message = format!(
                            "已连接{}",
                            session.active_name.as_deref().unwrap_or("资料库")
                        );
                    }
                });
                if let Some(name) = snapshot.active_name {
                    let _ = window.set_title(&format!("Trading Max · {name}"));
                }
            }
        })
        .build()?;
    #[cfg(target_os = "macos")]
    if let Ok(ns_window) = window.ns_window() {
        // Called on the main thread by the connection driver.
        unsafe { trading_max_install_drag_strip(ns_window, WORKSPACE_CHROME_BAND) };
    }
    let exit = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            exit.exit(0);
        }
    });
    #[cfg(feature = "diagnostics")]
    window.open_devtools();
    Ok(window)
}

fn failed(app: &tauri::AppHandle, desktop: &Arc<Desktop>, generation: u64, detail: String) {
    let already_showing_error = desktop.snapshot().stage == "error";
    if desktop.update(generation, |session| {
        session.stage = "error".into();
        session.message = if session
            .desired
            .as_ref()
            .is_some_and(|p| p.mode != Mode::Remote)
        {
            "本机服务需要重新启动。"
        } else {
            "暂时无法连接这份资料。"
        }
        .into();
        session.detail = detail;
        session.retry_at_ms = None;
        session.active_url = None;
        session.active_name = None;
    }) && !already_showing_error
    {
        home(app, desktop, generation);
    }
}
fn check_remote(
    app: &tauri::AppHandle,
    desktop: &Arc<Desktop>,
    generation: u64,
    profile: &Profile,
    recovery: &mut recovery::RemoteRecovery,
    loading_since: &mut Instant,
) -> Option<Duration> {
    match connection::probe(profile) {
        Ok(probe) => {
            recovery.recovered();
            let mut open_page = false;
            if desktop.update(generation, |session| {
                open_page = session.remote_recovered(probe)
            }) {
                if open_page {
                    enter(
                        app,
                        desktop,
                        generation,
                        profile.url.clone(),
                        profile.name.clone(),
                    );
                    *loading_since = Instant::now();
                } else {
                    // Recovery does not navigate, reload, steal focus or lose
                    // the selected lens, scroll position or unfinished form.
                    connection_notice(app, desktop, generation);
                }
            }
            Some(Duration::from_secs(45))
        }
        Err(error) => {
            let after = recovery.failed(error.retryable);
            let mut show_entry = false;
            if desktop.update(generation, |session| {
                show_entry = !session.workspace_available() && session.stage != "error";
                session.remote_failed(error, after);
            }) {
                if show_entry {
                    home(app, desktop, generation);
                }
                connection_notice(app, desktop, generation);
            }
            after
        }
    }
}
fn drive(app: tauri::AppHandle, desktop: Arc<Desktop>) {
    let mut seen = u64::MAX;
    let mut next_probe = Instant::now();
    let mut loading_since = Instant::now();
    let mut recovery = recovery::RemoteRecovery::default();
    let mut monitor_remote = false;
    while !desktop.exiting.load(Ordering::Relaxed) {
        let snapshot = desktop.snapshot();
        let generation = snapshot.generation;
        if generation != seen {
            // One driver owns local process transitions. New requests invalidate old probes.
            desktop.runtime.stop();
            if desktop.snapshot().generation != generation {
                continue;
            }
            seen = generation;
            recovery = recovery::RemoteRecovery::default();
            monitor_remote = false;
            match &snapshot.desired {
                None => {}
                Some(profile) if profile.mode == Mode::Remote => {
                    if let Some(delay) = check_remote(
                        &app,
                        &desktop,
                        generation,
                        profile,
                        &mut recovery,
                        &mut loading_since,
                    ) {
                        monitor_remote = true;
                        next_probe = Instant::now() + delay;
                    }
                }
                Some(profile) => {
                    if let Err(error) = desktop.runtime.start(
                        profile
                            .workspace
                            .as_ref()
                            .filter(|_| profile.mode == Mode::Local),
                    ) {
                        failed(&app, &desktop, generation, error);
                    }
                }
            }
        } else if let Some(profile) = &snapshot.desired {
            if profile.mode != Mode::Remote {
                let runtime = desktop.runtime.status();
                if runtime.stage == "ready"
                    && snapshot.active_url.is_none()
                    && snapshot.stage != "error"
                {
                    if let Some(url) = runtime.web_url {
                        enter(
                            &app,
                            &desktop,
                            generation,
                            url,
                            if profile.mode == Mode::Local {
                                profile.name.clone()
                            } else {
                                "本机演示 · 模拟数据".into()
                            },
                        );
                        loading_since = Instant::now();
                    }
                } else if runtime.stage == "error" && snapshot.stage != "error" {
                    failed(&app, &desktop, generation, runtime.detail);
                } else if snapshot.stage == "connecting" {
                    desktop.update(generation, |s| s.message = runtime.message);
                }
            } else if monitor_remote && Instant::now() >= next_probe {
                let after = check_remote(
                    &app,
                    &desktop,
                    generation,
                    profile,
                    &mut recovery,
                    &mut loading_since,
                );
                monitor_remote = after.is_some();
                if let Some(delay) = after {
                    next_probe = Instant::now() + delay;
                }
            }
            let current = desktop.snapshot();
            let load_timeout = if profile.mode == Mode::Remote { 90 } else { 35 };
            if current.generation == generation
                && current.stage == "loading"
                && loading_since.elapsed() > Duration::from_secs(load_timeout)
            {
                monitor_remote = false;
                failed(
                    &app,
                    &desktop,
                    generation,
                    "服务已响应，但页面加载超时。可以重试，或在浏览器中打开。".into(),
                );
                if profile.mode == Mode::Remote {
                    if let Some(delay) = recovery.failed(true) {
                        monitor_remote = true;
                        next_probe = Instant::now() + delay;
                        desktop.update(generation, |s| {
                            s.retry_at_ms = Some(connection::now_ms() + delay.as_millis() as u64)
                        });
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
    desktop.runtime.stop();
}
fn show_settings(app: &tauri::AppHandle) -> tauri::Result<()> {
    show_auxiliary(app, false)
}
fn show_workspaces(app: &tauri::AppHandle) -> tauri::Result<()> {
    show_auxiliary(app, true)
}
fn show_auxiliary(app: &tauri::AppHandle, picker: bool) -> tauri::Result<()> {
    let (label, path, title, width, height) = if picker {
        (
            "workspaces",
            "index.html?picker=1",
            "Trading Max · 工作区",
            760.0,
            800.0,
        )
    } else {
        (
            "settings",
            "settings.html",
            "Trading Max · 设置",
            860.0,
            640.0,
        )
    };
    if let Some(window) = app.get_webview_window(label) {
        return reveal_window(&window);
    }
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(path.into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(640.0, 540.0)
        .center()
        .resizable(true)
        // WKWebView can leave a hidden-at-creation settings surface unpainted.
        // Create it visible, just like the entry and workspace windows.
        .visible(true)
        .focused(true)
        .on_navigation(internal_url)
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                let _ = fit_webview(&window);
            }
        })
        .build()?;
    reveal_window(&window)
}
fn request_connection(
    app: &tauri::AppHandle,
    desktop: &Arc<Desktop>,
    profile: Option<Profile>,
    save: bool,
) -> Result<(), String> {
    // Opening a workspace should reveal it, even for a temporary demo that
    // deliberately leaves the saved connection profile untouched.
    let dismiss_settings = profile.is_some();
    let generation = desktop.request(profile, save, dismiss_settings)?;
    home(app, desktop, generation);
    Ok(())
}
fn read_workspaces(root: &std::path::Path) -> Vec<Workspace> {
    std::fs::read(root.join("workspaces.json"))
        .ok()
        .filter(|bytes| bytes.len() <= 65536)
        .and_then(|bytes| serde_json::from_slice::<Vec<Workspace>>(&bytes).ok())
        .unwrap_or_default()
        .into_iter()
        .take(8)
        .collect()
}
#[tauri::command]
async fn choose_workspace_folder(
    window: WebviewWindow,
    app: tauri::AppHandle,
) -> Result<Option<PathBuf>, String> {
    local_command(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .set_title("选择本机文件夹")
            .blocking_pick_folder()
            .map(|file| {
                file.into_path()
                    .map_err(|_| "请选择本机文件夹。".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|_| "未能打开文件夹选择器。".to_string())?
}
#[tauri::command]
async fn prepare_workspace(
    window: WebviewWindow,
    desktop: tauri::State<'_, Arc<Desktop>>,
    path: PathBuf,
    name: Option<String>,
) -> Result<Workspace, String> {
    local_command(&window)?;
    let desktop = desktop.inner().clone();
    tauri::async_runtime::spawn_blocking(move || desktop.runtime.workspace(&path, name.as_deref()))
        .await
        .map_err(|_| "工作区检查没有完成。".to_string())?
}
#[tauri::command]
async fn open_local_workspace(
    window: WebviewWindow,
    app: tauri::AppHandle,
    desktop: tauri::State<'_, Arc<Desktop>>,
    workspace: Workspace,
) -> Result<(), String> {
    local_command(&window)?;
    let desktop = desktop.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let checked = desktop.runtime.workspace(&workspace.path, None)?;
        if checked != workspace {
            return Err("工作区已变化，请重新选择。".into());
        }
        {
            let mut session = desktop.session.lock().unwrap();
            let mut recent = session.workspaces.clone();
            recent.retain(|item| item.path != checked.path);
            recent.insert(0, checked.clone());
            recent.truncate(8);
            connection::write_private_json(&desktop.root, "workspaces.json", &recent)?;
            session.workspaces = recent;
        }
        let profile = Profile {
            mode: Mode::Local,
            name: checked.name.clone(),
            url: String::new(),
            workspace: Some(checked),
            auto_connect: false,
            ..Profile::default()
        };
        request_connection(&app, &desktop, Some(profile), false)
    })
    .await
    .map_err(|_| "工作区没有打开。".to_string())?
}
#[tauri::command]
fn desktop_status(
    window: WebviewWindow,
    desktop: tauri::State<'_, Arc<Desktop>>,
) -> Result<DesktopStatus, String> {
    local_command(&window)?;
    let mut snapshot = desktop.snapshot();
    let mode = snapshot
        .desired
        .as_ref()
        .map(|profile| profile.mode.clone());
    let workspace = snapshot
        .desired
        .as_ref()
        .and_then(|profile| profile.workspace.clone());
    let can_open_browser = browser_url(&snapshot).is_some();
    let source_name = snapshot
        .desired
        .as_ref()
        .map(|profile| profile.name.clone());
    let source_address = snapshot
        .desired
        .as_ref()
        .and_then(|profile| (profile.mode == Mode::Remote).then(|| profile.url.clone()));
    if let Ok(Some(saved)) = connection::read_profile(&desktop.root) {
        snapshot.profile = saved;
    }
    Ok(DesktopStatus {
        session: snapshot,
        mode,
        workspace,
        source_name,
        source_address,
        can_open_browser,
    })
}

#[derive(Serialize)]
struct DesktopStatus {
    #[serde(flatten)]
    session: Session,
    mode: Option<Mode>,
    workspace: Option<Workspace>,
    source_name: Option<String>,
    source_address: Option<String>,
    can_open_browser: bool,
}

fn browser_url(session: &Session) -> Option<tauri::Url> {
    if let Some(address) = &session.active_url {
        let url: tauri::Url = address.parse().ok()?;
        if workspace_url(&url, Some(address)) {
            return Some(url);
        }
    }
    let profile = session.desired.as_ref()?;
    (profile.mode == Mode::Remote)
        .then(|| connection::remote_url(&profile.url).ok())
        .flatten()
}

#[tauri::command]
fn show_workspace_folder(
    window: WebviewWindow,
    desktop: tauri::State<'_, Arc<Desktop>>,
) -> Result<(), String> {
    local_command(&window)?;
    let workspace = desktop
        .snapshot()
        .desired
        .and_then(|profile| profile.workspace)
        .ok_or("当前没有选中的本地工作区。")?;
    if !workspace.path.is_absolute() || !workspace.path.is_dir() {
        return Err("工作区文件夹暂时不可用，请重新选择位置。".into());
    }
    Command::new("/usr/bin/open")
        .arg(&workspace.path)
        .spawn()
        .map_err(|_| "未能打开工作区文件夹。")?;
    Ok(())
}

#[tauri::command]
async fn check_updates(window: WebviewWindow) -> Result<updates::UpdateCheck, String> {
    local_command(&window)?;
    tauri::async_runtime::spawn_blocking(updates::check)
        .await
        .map_err(|_| "版本检查没有完成。".to_string())?
}

#[tauri::command]
async fn open_desktop_download(window: WebviewWindow, version: String) -> Result<(), String> {
    local_command(&window)?;
    let url = tauri::async_runtime::spawn_blocking(move || updates::download_url(&version))
        .await
        .map_err(|_| "安装包检查没有完成。".to_string())??;
    local_command(&window)?;
    Command::new("/usr/bin/open")
        .arg(url.as_str())
        .spawn()
        .map_err(|_| "无法打开浏览器，请稍后重试。".to_string())?;
    Ok(())
}

#[tauri::command]
async fn install_desktop_update(
    window: WebviewWindow,
    app: tauri::AppHandle,
    version: String,
) -> Result<(), String> {
    local_command(&window)?;
    let feed = tauri::async_runtime::spawn_blocking(move || updates::update_feed(&version))
        .await
        .map_err(|_| "更新检查没有完成。".to_string())??;
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let result = local_command(&window).and_then(|_| sparkle::start(feed));
        let _ = send.send(result);
    })
    .map_err(|_| "无法打开原生更新窗口。".to_string())?;
    tauri::async_runtime::spawn_blocking(move || receive.recv())
        .await
        .map_err(|_| "更新窗口已关闭。".to_string())?
        .map_err(|_| "更新窗口已关闭。".to_string())?
}

#[tauri::command]
fn show_recovery_folder(
    window: WebviewWindow,
    desktop: tauri::State<'_, Arc<Desktop>>,
) -> Result<(), String> {
    local_command(&window)?;
    let workspace = desktop
        .snapshot()
        .desired
        .filter(|p| p.mode == Mode::Local)
        .and_then(|p| p.workspace)
        .ok_or("请先选择本地工作区；远程服务的恢复由服务端管理。")?;
    if workspace.id.len() != 36
        || !workspace
            .id
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b'-')
    {
        return Err("工作区标识无法识别。".into());
    }
    let parent = desktop.root.join("workspace-recovery");
    let folder = parent.join(workspace.id);
    if parent.is_symlink() || folder.is_symlink() || !folder.is_dir() {
        return Err("这份资料还没有本机升级恢复记录，或恢复目录暂时不可用。".into());
    }
    Command::new("/usr/bin/open")
        .arg(folder)
        .spawn()
        .map_err(|_| "无法打开恢复目录。".to_string())?;
    Ok(())
}

#[tauri::command]
fn open_issue_tracker(window: WebviewWindow) -> Result<(), String> {
    local_command(&window)?;
    Command::new("/usr/bin/open")
        .arg("https://github.com/engramai-co/trading-max/issues")
        .spawn()
        .map_err(|_| "无法打开问题反馈页面。".to_string())?;
    Ok(())
}

#[tauri::command]
fn open_release_notes(window: WebviewWindow, version: String) -> Result<(), String> {
    local_command(&window)?;
    open_external(&updates::notes_url(&version)?);
    Ok(())
}
#[tauri::command]
fn connect_profile(
    window: WebviewWindow,
    app: tauri::AppHandle,
    desktop: tauri::State<'_, Arc<Desktop>>,
    profile: Profile,
) -> Result<(), String> {
    local_command(&window)?;
    request_connection(&app, &desktop, Some(profile.validated()?), true)
}
#[tauri::command]
fn save_profile(
    window: WebviewWindow,
    desktop: tauri::State<'_, Arc<Desktop>>,
    profile: Profile,
) -> Result<(), String> {
    local_command(&window)?;
    let profile = profile.validated()?;
    let mut session = desktop.session.lock().unwrap();
    connection::write_private_json(&desktop.root, "connection.json", &profile)?;
    session.profile = profile;
    Ok(())
}
#[tauri::command]
async fn test_connection(window: WebviewWindow, profile: Profile) -> Result<Probe, String> {
    local_command(&window)?;
    let profile = profile.validated()?;
    if profile.mode != Mode::Remote {
        return Err("本机演示无需测试远程连接。".into());
    }
    tauri::async_runtime::spawn_blocking(move || connection::probe(&profile))
        .await
        .map_err(|_| "连接测试没有完成。".to_string())?
        .map_err(|error| error.message)
}
#[tauri::command]
fn retry_connection(
    window: WebviewWindow,
    app: tauri::AppHandle,
    desktop: tauri::State<'_, Arc<Desktop>>,
) -> Result<(), String> {
    local_command(&window)?;
    let snapshot = desktop.snapshot();
    let profile = snapshot.desired.unwrap_or(snapshot.profile).validated()?;
    request_connection(&app, &desktop, Some(profile), false)
}
#[tauri::command]
fn disconnect(
    window: WebviewWindow,
    app: tauri::AppHandle,
    desktop: tauri::State<'_, Arc<Desktop>>,
) -> Result<(), String> {
    local_command(&window)?;
    request_connection(&app, &desktop, None, false)
}
#[tauri::command]
fn open_settings(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    local_command(&window)?;
    show_settings(&app).map_err(|e| e.to_string())
}
#[tauri::command]
fn open_workspaces(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    local_command(&window)?;
    show_workspaces(&app).map_err(|e| e.to_string())
}
/// Removes a workspace from the recent list only; its folder is untouched.
#[tauri::command]
fn forget_workspace(
    window: WebviewWindow,
    desktop: tauri::State<'_, Arc<Desktop>>,
    path: PathBuf,
) -> Result<(), String> {
    local_command(&window)?;
    let mut session = desktop.session.lock().unwrap();
    let mut recent = session.workspaces.clone();
    recent.retain(|item| item.path != path);
    connection::write_private_json(&desktop.root, "workspaces.json", &recent)?;
    session.workspaces = recent;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum WorkspacePage {
    Current,
    Settings,
    Health,
    Imports,
}

fn workspace_destination(address: &str, page: &WorkspacePage) -> Result<tauri::Url, String> {
    let mut url = tauri::Url::parse(address).map_err(|_| "工作区地址不可用。")?;
    if !workspace_url(&url, Some(address)) || !url.username().is_empty() || url.password().is_some()
    {
        return Err("工作区地址不可用。".into());
    }
    match page {
        WorkspacePage::Current => {}
        WorkspacePage::Settings | WorkspacePage::Health | WorkspacePage::Imports => {
            url.set_path(match page {
                WorkspacePage::Settings => "/settings",
                WorkspacePage::Imports => "/desktop/imports",
                _ => "/health",
            });
            url.set_query(None);
            url.set_fragment(None);
        }
    }
    Ok(url)
}

#[tauri::command]
fn open_workspace_page(
    window: WebviewWindow,
    app: tauri::AppHandle,
    desktop: tauri::State<'_, Arc<Desktop>>,
    page: WorkspacePage,
) -> Result<(), String> {
    local_command(&window)?;
    open_service_page(&app, &desktop, page)
}

fn open_service_page(
    app: &tauri::AppHandle,
    desktop: &Arc<Desktop>,
    page: WorkspacePage,
) -> Result<(), String> {
    let snapshot = desktop.snapshot();
    if !snapshot.workspace_available() {
        return Err("请先连接工作区。断线时仍可使用 App 设置。".into());
    }
    let address = snapshot.active_url.as_deref().ok_or("请先连接工作区。")?;
    if matches!(page, WorkspacePage::Current) {
        let workspace = app
            .get_webview_window("workspace")
            .ok_or("工作区尚未打开。")?;
        return reveal_window(&workspace).map_err(|e| e.to_string());
    }
    let mut target = workspace_destination(address, &page)?;
    if snapshot.desktop_presentation {
        target = surfaces::presentation_url(target);
    } else if matches!(page, WorkspacePage::Imports) {
        target.set_path("/settings");
    }
    surfaces::open(app, desktop, target)
}

fn update_auto_connect(root: &std::path::Path, enabled: bool) -> Result<Profile, String> {
    let mut saved = connection::read_profile(root)?.ok_or("请先保存一个服务连接。")?;
    if saved.mode != Mode::Remote {
        return Err("启动偏好仅适用于已保存的服务连接。".into());
    }
    saved.auto_connect = enabled;
    let saved = saved.validated()?;
    connection::write_private_json(root, "connection.json", &saved)?;
    Ok(saved)
}

#[tauri::command]
fn set_auto_connect(
    window: WebviewWindow,
    desktop: tauri::State<'_, Arc<Desktop>>,
    enabled: bool,
) -> Result<Profile, String> {
    local_command(&window)?;
    // Serialize with connection edits, and read the newest saved profile so a
    // stale settings window cannot replace its name/address or active session.
    let _session = desktop.session.lock().unwrap();
    update_auto_connect(&desktop.root, enabled)
}
#[tauri::command]
fn open_demo(
    window: WebviewWindow,
    app: tauri::AppHandle,
    desktop: tauri::State<'_, Arc<Desktop>>,
) -> Result<(), String> {
    local_command(&window)?;
    // A quick demo is temporary: reopening still uses the saved server profile.
    let profile = Profile {
        mode: Mode::Demo,
        workspace: None,
        ..desktop.snapshot().profile
    };
    request_connection(&app, &desktop, Some(profile.validated()?), false)
}
#[tauri::command]
fn open_in_browser(
    window: WebviewWindow,
    desktop: tauri::State<'_, Arc<Desktop>>,
) -> Result<(), String> {
    local_command(&window)?;
    open_external(&browser_url(&desktop.snapshot()).ok_or("当前没有可打开的网页。")?);
    Ok(())
}
fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "设置…", true, Some("CmdOrCtrl+,"))?;
    let application = SubmenuBuilder::new(app, "Trading Max")
        .about(None)
        .separator()
        .item(&settings)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let workspaces = MenuItem::with_id(
        app,
        "workspaces",
        "切换工作区…",
        true,
        Some("CmdOrCtrl+Shift+O"),
    )?;
    let file = SubmenuBuilder::new(app, "文件")
        .item(&workspaces)
        .text("imports", "导入记录…")
        .separator()
        .close_window_with_text("关闭窗口")
        .build()?;
    let reconnect = MenuItem::with_id(app, "reconnect", "重新连接", true, Some("CmdOrCtrl+R"))?;
    let connection = SubmenuBuilder::new(app, "连接")
        .item(&reconnect)
        .text("browser", "在浏览器打开")
        .separator()
        .text("disconnect", "断开当前连接")
        .build()?;
    let activity = MenuItem::with_id(
        app,
        "activity",
        "同步与活动…",
        true,
        Some("CmdOrCtrl+Shift+J"),
    )?;
    let service_settings = MenuItem::with_id(
        app,
        "service-settings",
        "工作区设置…",
        true,
        Some("CmdOrCtrl+Alt+,"),
    )?;
    let view = SubmenuBuilder::new(app, "工作区")
        .item(&activity)
        .item(&service_settings)
        .build()?;
    let edit = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    app.set_menu(
        MenuBuilder::new(app)
            .items(&[&application, &file, &edit, &view, &connection])
            .build()?,
    )?;
    app.on_menu_event(|app, event| {
        let desktop = app.state::<Arc<Desktop>>();
        match event.id().as_ref() {
            "settings" => {
                let _ = show_settings(app);
            }
            "workspaces" => {
                let _ = show_workspaces(app);
            }
            "activity" | "service-settings" | "imports" => {
                let page = match event.id().as_ref() {
                    "activity" => WorkspacePage::Health,
                    "imports" => WorkspacePage::Imports,
                    _ => WorkspacePage::Settings,
                };
                if open_service_page(app, &desktop, page).is_err() {
                    let _ = show_workspaces(app);
                }
            }
            "reconnect" => {
                let snapshot = desktop.snapshot();
                if let Ok(profile) = snapshot.desired.unwrap_or(snapshot.profile).validated() {
                    let _ = request_connection(app, &desktop, Some(profile), false);
                } else {
                    let _ = show_workspaces(app);
                }
            }
            "disconnect" => {
                let _ = request_connection(app, &desktop, None, false);
            }
            "browser" => {
                if let Some(url) = browser_url(&desktop.snapshot()) {
                    open_external(&url);
                }
            }
            _ => {}
        }
    });
    Ok(())
}
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let ready = app.state::<Arc<Desktop>>().snapshot().workspace_available();
            let label = if ready { "workspace" } else { "main" };
            if let Some(window) = app.get_webview_window(label) {
                let _ = reveal_window(&window);
            }
        }))
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            connect_profile,
            save_profile,
            test_connection,
            retry_connection,
            disconnect,
            open_settings,
            open_workspaces,
            forget_workspace,
            open_workspace_page,
            set_auto_connect,
            open_demo,
            open_in_browser,
            choose_workspace_folder,
            prepare_workspace,
            open_local_workspace,
            show_workspace_folder,
            show_recovery_folder,
            check_updates,
            open_desktop_download,
            install_desktop_update,
            open_issue_tracker,
            open_release_notes
        ])
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            runtime::prepare_root(&root).map_err(std::io::Error::other)?;
            let (profile, config_error) = match connection::read_profile(&root) {
                Ok(Some(profile)) => (profile, None),
                Ok(None) => (Profile::default(), None),
                Err(error) => (Profile::default(), Some(error)),
            };
            let reopen = sparkle::take_reopen(&root);
            let autostart = if config_error.is_none() {
                reopen.or_else(|| {
                    (profile.auto_connect && profile.clone().validated().is_ok())
                        .then(|| profile.clone())
                })
            } else {
                None
            };
            let desktop = Arc::new(Desktop {
                runtime: Runtime::new(root.clone(), app.path().resource_dir()?.join("runtime")),
                root: root.clone(),
                session: Mutex::new(Session {
                    app_version: env!("CARGO_PKG_VERSION"),
                    profile: profile.clone(),
                    workspaces: read_workspaces(&root),
                    generation: 0,
                    stage: if config_error.is_some() {
                        "error"
                    } else {
                        "idle"
                    }
                    .into(),
                    message: "选择你的数据来源。".into(),
                    detail: config_error.unwrap_or_default(),
                    active_url: None,
                    active_name: None,
                    probe: None,
                    desktop_presentation: false,
                    retry_at_ms: None,
                    desired: None,
                    dismiss_settings: false,
                }),
                exiting: AtomicBool::new(false),
            });
            app.manage(desktop.clone());
            sparkle::initialize(app.handle().clone());
            install_menu(app.handle())?;
            // The native entry never navigates to HTTP. It remains a working
            // recovery surface even if the portfolio WebView loses its service.
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Trading Max · 工作区与连接")
                    .inner_size(1280.0, 840.0)
                    .min_inner_size(900.0, 640.0)
                    .center()
                    .visible(true)
                    .on_navigation(internal_url)
                    .build()?;
            reveal_window(&window)?;
            #[cfg(feature = "diagnostics")]
            window.open_devtools();
            let exit = app.handle().clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                    exit.exit(0);
                }
            });
            if let Some(profile) = autostart {
                let _ = desktop.request(Some(profile), false, false);
            }
            let app = app.handle().clone();
            thread::spawn(move || drive(app, desktop));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("无法创建 Trading Max 窗口");
    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            let desktop = handle.state::<Arc<Desktop>>();
            desktop.exiting.store(true, Ordering::Relaxed);
            desktop.runtime.stop();
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    fn remote_session(stage: &str) -> Session {
        let profile = Profile {
            url: "https://synthetic.example.test/".into(),
            ..Profile::default()
        };
        Session {
            app_version: env!("CARGO_PKG_VERSION"),
            profile: profile.clone(),
            workspaces: vec![],
            generation: 1,
            stage: stage.into(),
            message: String::new(),
            detail: String::new(),
            active_url: (stage != "connecting").then(|| profile.url.clone()),
            active_name: (stage != "connecting").then(|| profile.name.clone()),
            probe: None,
            desktop_presentation: true,
            retry_at_ms: None,
            desired: Some(profile),
            dismiss_settings: false,
        }
    }
    fn healthy_probe() -> Probe {
        Probe {
            checked_at_ms: connection::now_ms(),
            healthy: true,
            worker_healthy: Some(true),
            artifact_age_seconds: Some(10.0),
        }
    }
    #[test]
    fn a_long_outage_preserves_the_live_page_and_recovers_without_navigation() {
        let mut session = remote_session("ready");
        session.probe = Some(healthy_probe());
        let original_url = session.active_url.clone();
        let original_name = session.active_name.clone();
        let mut policy = recovery::RemoteRecovery::default();
        policy.recovered();
        for _ in 0..100 {
            session.remote_failed(
                connection::ProbeError {
                    message: "synthetic timeout".into(),
                    retryable: true,
                },
                policy.failed(true),
            );
            assert_eq!(session.stage, "reconnecting");
            assert!(session.workspace_available());
            assert!(session.retry_at_ms.is_some());
            assert!(session.probe.is_none());
            assert_eq!(session.active_url, original_url);
            assert_eq!(session.active_name, original_name);
            assert!(session.desktop_presentation);
        }
        assert!(!session.remote_recovered(healthy_probe()));
        assert_eq!(session.stage, "ready");
        assert_eq!(session.active_url, original_url);
        assert!(session.retry_at_ms.is_none());
        assert!(session.detail.is_empty());
    }
    #[test]
    fn first_load_and_permanent_errors_do_not_claim_an_available_workspace() {
        for stage in ["connecting", "loading"] {
            let mut session = remote_session(stage);
            session.remote_failed(
                connection::ProbeError {
                    message: "synthetic timeout".into(),
                    retryable: true,
                },
                Some(Duration::from_secs(5)),
            );
            assert_eq!(session.stage, "error");
            assert!(!session.workspace_available());
            assert!(session.active_url.is_none());
            assert!(session.remote_recovered(healthy_probe()));
        }
        let mut session = remote_session("ready");
        session.remote_failed(
            connection::ProbeError {
                message: "HTTP 403".into(),
                retryable: false,
            },
            None,
        );
        assert_eq!(session.stage, "offline");
        assert!(session.workspace_available());
        assert!(session.retry_at_ms.is_none());
        assert!(session.probe.is_none());
    }
    #[test]
    fn a_health_check_is_not_a_finished_page() {
        let mut session = remote_session("loading");
        assert!(!session.remote_recovered(healthy_probe()));
        assert_eq!(session.stage, "loading");
        assert!(!session.workspace_available());
    }
    #[test]
    fn native_commands_stay_local() {
        let native = "tauri://localhost/index.html".parse().unwrap();
        assert!(native_surface("main", &native));
        assert!(native_surface("settings", &native));
        assert!(native_surface("workspaces", &native));
        assert!(!native_surface("workspace", &native));
        for label in surfaces::LABELS {
            assert!(!native_surface(label, &native));
            assert!(!native_surface(
                label,
                &"https://mini.example.test/desktop/settings"
                    .parse()
                    .unwrap()
            ));
        }
        assert!(internal_url(
            &"tauri://localhost/index.html".parse().unwrap()
        ));
        for url in [
            "https://mini.example.test/",
            "http://127.0.0.1:43000/",
            "tauri://evil/index.html",
        ] {
            assert!(!internal_url(&url.parse().unwrap()));
            assert!(!native_surface("main", &url.parse().unwrap()));
            assert!(!native_surface("settings", &url.parse().unwrap()));
            assert!(!native_surface("workspaces", &url.parse().unwrap()));
            assert!(!native_surface("workspace", &url.parse().unwrap()));
        }
    }
    #[test]
    fn settings_links_stay_on_the_selected_service() {
        for base in [
            "https://mini.example.test/analytics?range=3M#chart",
            "http://127.0.0.1:43000/settings?tab=accounts",
        ] {
            let original: tauri::Url = base.parse().unwrap();
            let target = workspace_destination(base, &WorkspacePage::Health).unwrap();
            assert_eq!(target.origin(), original.origin());
            assert_eq!(target.path(), "/health");
            assert!(target.query().is_none() && target.fragment().is_none());
            assert_eq!(
                workspace_destination(base, &WorkspacePage::Settings)
                    .unwrap()
                    .path(),
                "/settings"
            );
            assert_eq!(
                workspace_destination(base, &WorkspacePage::Current).unwrap(),
                original
            );
        }
        for base in [
            "file:///etc/passwd",
            "https://user:secret@example.test/",
            "http://other.test/",
            "javascript:alert(1)",
        ] {
            assert!(workspace_destination(base, &WorkspacePage::Settings).is_err());
        }
    }
    #[test]
    fn startup_preference_changes_only_the_saved_flag() {
        let root = std::env::temp_dir().join(format!(
            "tm-startup-setting-{}-{}",
            std::process::id(),
            connection::now_ms()
        ));
        assert!(update_auto_connect(&root, false).is_err());
        let saved = Profile {
            url: "https://new.example.test/".into(),
            name: "New connection".into(),
            auto_connect: true,
            ..Profile::default()
        };
        connection::write_private_json(&root, "connection.json", &saved).unwrap();
        let updated = update_auto_connect(&root, false).unwrap();
        assert_eq!(
            updated,
            Profile {
                auto_connect: false,
                ..saved.clone()
            }
        );
        assert_eq!(update_auto_connect(&root, true).unwrap(), saved);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn active_workspace_has_an_exact_origin() {
        for base in ["https://mini.example.test/", "http://127.0.0.1:43000/"] {
            assert!(workspace_url(
                &format!("{base}analytics?range=6M").parse().unwrap(),
                Some(base)
            ));
            for other in [
                "https://mini.example.test.evil/",
                "https://other.test/",
                "http://127.0.0.1:43001/",
                "http://mini.example.test/",
            ] {
                assert!(!workspace_url(&other.parse().unwrap(), Some(base)));
            }
        }
        assert!(!workspace_url(
            &"https://mini.example.test/".parse().unwrap(),
            None
        ));
    }
    #[test]
    fn temporary_demo_keeps_saved_server_and_auto_open_preference() {
        let root = std::env::temp_dir().join(format!(
            "tm-demo-profile-{}-{}",
            std::process::id(),
            connection::now_ms()
        ));
        let profile = Profile {
            url: "https://saved.example.test/".into(),
            auto_connect: false,
            ..Profile::default()
        };
        connection::write_private_json(&root, "connection.json", &profile).unwrap();
        let desktop = Desktop {
            runtime: Runtime::new(root.clone(), root.clone()),
            root: root.clone(),
            exiting: AtomicBool::new(false),
            session: Mutex::new(Session {
                app_version: env!("CARGO_PKG_VERSION"),
                profile: profile.clone(),
                workspaces: vec![],
                generation: 0,
                stage: "idle".into(),
                message: String::new(),
                detail: String::new(),
                active_url: None,
                active_name: None,
                probe: None,
                desktop_presentation: false,
                retry_at_ms: None,
                desired: None,
                dismiss_settings: false,
            }),
        };
        let demo = Profile {
            mode: Mode::Demo,
            ..profile.clone()
        };
        desktop.request(Some(demo), false, true).unwrap();
        assert!(desktop.snapshot().dismiss_settings);
        assert_eq!(desktop.snapshot().desired.unwrap().mode, Mode::Demo);
        // The saved service is a recent entry, not a fallback for local recovery.
        assert!(browser_url(&desktop.snapshot()).is_none());
        let generation = desktop.snapshot().generation;
        desktop.update(generation, |s| {
            s.active_url = Some("http://127.0.0.1:43000/settings".into())
        });
        assert_eq!(
            browser_url(&desktop.snapshot()).unwrap().as_str(),
            "http://127.0.0.1:43000/settings"
        );
        assert_eq!(connection::read_profile(&root).unwrap(), Some(profile));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancelled_work_cannot_reactivate_a_previous_connection() {
        let root = std::env::temp_dir().join(format!(
            "tm-session-test-{}-{}",
            std::process::id(),
            connection::now_ms()
        ));
        let desktop = Desktop {
            runtime: Runtime::new(root.clone(), root.clone()),
            root: root.clone(),
            exiting: AtomicBool::new(false),
            session: Mutex::new(Session {
                app_version: env!("CARGO_PKG_VERSION"),
                profile: Profile::default(),
                workspaces: vec![],
                generation: 0,
                stage: "idle".into(),
                message: String::new(),
                detail: String::new(),
                active_url: None,
                active_name: None,
                probe: None,
                desktop_presentation: false,
                retry_at_ms: None,
                desired: None,
                dismiss_settings: false,
            }),
        };
        let profile = Profile {
            url: "https://mini.example.test/".into(),
            ..Profile::default()
        };
        let old = desktop.request(Some(profile), false, false).unwrap();
        desktop.request(None, false, false).unwrap();
        assert!(!desktop.update(old, |s| s.active_url =
            Some("https://mini.example.test/".into())));
        assert!(desktop.snapshot().active_url.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
