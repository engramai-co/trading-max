#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod connection;
mod runtime;

use connection::{Mode, Probe, Profile};
use runtime::Runtime;
use serde::Serialize;
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

#[derive(Clone, Serialize)]
struct Session {
    app_version: &'static str,
    profile: Profile,
    generation: u64,
    stage: String,
    message: String,
    detail: String,
    active_url: Option<String>,
    active_name: Option<String>,
    probe: Option<Probe>,
    #[serde(skip)]
    desired: Option<Profile>,
    #[serde(skip)]
    dismiss_settings: bool,
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
        session.stage = if session.desired.is_some() {
            "connecting"
        } else {
            "idle"
        }
        .into();
        session.message = match &session.desired {
            Some(p) if p.mode == Mode::Remote => format!("正在连接{}…", p.name),
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
fn local_command(window: &WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "main" | "settings")
        && window.url().is_ok_and(|url| internal_url(&url))
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
    window.set_focus()
}
fn home(app: &tauri::AppHandle, desktop: &Arc<Desktop>, generation: u64) {
    let app = app.clone();
    let desktop = desktop.clone();
    let handle = app.clone();
    let _ = handle.run_on_main_thread(move || {
        if desktop.snapshot().generation != generation {
            return;
        }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_title("Trading Max · 工作区与连接");
            let _ = window.navigate("tauri://localhost/index.html".parse().unwrap());
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
    let app = app.clone();
    let desktop = desktop.clone();
    let handle = app.clone();
    let _ = handle.run_on_main_thread(move || {
        if desktop.snapshot().generation != generation {
            return;
        }
        let Ok(url) = tauri::Url::parse(&address) else {
            return;
        };
        let dismiss_settings = desktop.snapshot().dismiss_settings;
        desktop.update(generation, |session| {
            session.active_url = Some(address);
            session.active_name = Some(name.clone());
            session.stage = "loading".into();
            session.message = format!("正在打开{name}…");
            session.detail.clear();
        });
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_title(&format!("Trading Max · {name}"));
            if let Err(error) = window.navigate(url) {
                desktop.update(generation, |session| {
                    session.stage = "error".into();
                    session.message = "页面暂时没有打开。".into();
                    session.detail = error.to_string();
                    session.active_url = None;
                });
                home(&app, &desktop, generation);
            } else {
                let _ = window.show();
                if let Some(settings) = app.get_webview_window("settings") {
                    if dismiss_settings {
                        let _ = settings.close();
                        let _ = reveal_window(&window);
                    }
                } else {
                    let _ = reveal_window(&window);
                }
            }
        }
    });
}
fn failed(app: &tauri::AppHandle, desktop: &Arc<Desktop>, generation: u64, detail: String) {
    let already_showing_error = desktop.snapshot().stage == "error";
    if desktop.update(generation, |session| {
        session.stage = "error".into();
        session.message = "暂时无法打开这份资料。".into();
        session.detail = detail;
        session.active_url = None;
        session.active_name = None;
    }) && !already_showing_error
    {
        home(app, desktop, generation);
    }
}
fn drive(app: tauri::AppHandle, desktop: Arc<Desktop>) {
    let mut seen = u64::MAX;
    let mut next_probe = Instant::now();
    let mut loading_since = Instant::now();
    let mut failures = 0;
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
            failures = 0;
            monitor_remote = false;
            match &snapshot.desired {
                None => {}
                Some(profile) if profile.mode == Mode::Remote => {
                    match connection::probe(profile) {
                        Ok(probe) => {
                            if desktop.update(generation, |s| s.probe = Some(probe)) {
                                enter(
                                    &app,
                                    &desktop,
                                    generation,
                                    profile.url.clone(),
                                    profile.name.clone(),
                                );
                                monitor_remote = true;
                                loading_since = Instant::now();
                            }
                        }
                        Err(error) => failed(&app, &desktop, generation, error),
                    }
                    next_probe = Instant::now() + Duration::from_secs(45);
                }
                Some(_) => {
                    if let Err(error) = desktop.runtime.start() {
                        failed(&app, &desktop, generation, error);
                    }
                }
            }
        } else if let Some(profile) = &snapshot.desired {
            if profile.mode == Mode::Demo {
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
                            "本机演示 · 模拟数据".into(),
                        );
                        loading_since = Instant::now();
                    }
                } else if runtime.stage == "error" && snapshot.stage != "error" {
                    failed(&app, &desktop, generation, runtime.detail);
                } else if snapshot.stage == "connecting" {
                    desktop.update(generation, |s| s.message = runtime.message);
                }
            } else if monitor_remote && Instant::now() >= next_probe {
                match connection::probe(profile) {
                    Ok(probe) => {
                        failures = 0;
                        if desktop.update(generation, |s| {
                            s.probe = Some(probe);
                            s.detail.clear();
                        }) && snapshot.stage == "error"
                        {
                            enter(
                                &app,
                                &desktop,
                                generation,
                                profile.url.clone(),
                                profile.name.clone(),
                            );
                            loading_since = Instant::now();
                        }
                    }
                    Err(error) => {
                        failures += 1;
                        if failures >= 2 {
                            failed(&app, &desktop, generation, error);
                        } else {
                            desktop.update(generation, |s| {
                                s.detail = "连接检查暂时未成功，正在重试。".into()
                            });
                        }
                    }
                }
                next_probe = Instant::now() + Duration::from_secs(45);
            }
            if snapshot.stage == "loading" && loading_since.elapsed() > Duration::from_secs(35) {
                monitor_remote = false;
                failed(
                    &app,
                    &desktop,
                    generation,
                    "服务已响应，但页面加载超时。可以重试，或在浏览器中打开。".into(),
                );
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
    desktop.runtime.stop();
}
fn show_settings(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("settings") {
        return reveal_window(&window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        "settings",
        WebviewUrl::App("index.html?settings=1".into()),
    )
    .title("Trading Max · 工作区与连接")
    .inner_size(740.0, 860.0)
    .min_inner_size(580.0, 680.0)
    .center()
    .resizable(true)
    .visible(false)
    .on_navigation(internal_url)
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
#[tauri::command]
fn desktop_status(
    window: WebviewWindow,
    desktop: tauri::State<'_, Arc<Desktop>>,
) -> Result<Session, String> {
    local_command(&window)?;
    Ok(desktop.snapshot())
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
}
#[tauri::command]
fn retry_connection(
    window: WebviewWindow,
    app: tauri::AppHandle,
    desktop: tauri::State<'_, Arc<Desktop>>,
) -> Result<(), String> {
    local_command(&window)?;
    let profile = desktop.snapshot().profile.validated()?;
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
fn open_demo(
    window: WebviewWindow,
    app: tauri::AppHandle,
    desktop: tauri::State<'_, Arc<Desktop>>,
) -> Result<(), String> {
    local_command(&window)?;
    // A quick demo is temporary: reopening still uses the saved server profile.
    let profile = Profile {
        mode: Mode::Demo,
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
    open_external(&connection::remote_url(&desktop.snapshot().profile.url)?);
    Ok(())
}
fn install_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let settings = MenuItem::with_id(app, "settings", "工作区与连接…", true, Some("CmdOrCtrl+,"))?;
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
    let reconnect = MenuItem::with_id(app, "reconnect", "重新连接", true, Some("CmdOrCtrl+R"))?;
    let connection = SubmenuBuilder::new(app, "连接")
        .item(&reconnect)
        .text("browser", "在浏览器打开")
        .separator()
        .text("disconnect", "断开当前连接")
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
            .items(&[&application, &connection, &edit])
            .build()?,
    )?;
    app.on_menu_event(|app, event| {
        let desktop = app.state::<Arc<Desktop>>();
        match event.id().as_ref() {
            "settings" => {
                let _ = show_settings(app);
            }
            "reconnect" => {
                if let Ok(profile) = desktop.snapshot().profile.validated() {
                    let _ = request_connection(app, &desktop, Some(profile), false);
                } else {
                    let _ = show_settings(app);
                }
            }
            "disconnect" => {
                let _ = request_connection(app, &desktop, None, false);
            }
            "browser" => {
                let snapshot = desktop.snapshot();
                if let Some(url) = snapshot.active_url {
                    if let Ok(url) = tauri::Url::parse(&url) {
                        open_external(&url);
                    }
                } else if let Ok(url) = connection::remote_url(&snapshot.profile.url) {
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
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
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
            open_demo,
            open_in_browser
        ])
        .setup(|app| {
            let root = app.path().app_data_dir()?;
            runtime::prepare_root(&root).map_err(std::io::Error::other)?;
            let (profile, config_error) = match connection::read_profile(&root) {
                Ok(Some(profile)) => (profile, None),
                Ok(None) => (Profile::default(), None),
                Err(error) => (Profile::default(), Some(error)),
            };
            let autostart = profile.auto_connect
                && profile.clone().validated().is_ok()
                && config_error.is_none();
            let desktop = Arc::new(Desktop {
                runtime: Runtime::new(root.clone(), app.path().resource_dir()?.join("runtime")),
                root,
                session: Mutex::new(Session {
                    app_version: env!("CARGO_PKG_VERSION"),
                    profile: profile.clone(),
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
                    desired: None,
                    dismiss_settings: false,
                }),
                exiting: AtomicBool::new(false),
            });
            app.manage(desktop.clone());
            install_menu(app.handle())?;
            let navigation = desktop.clone();
            let pages = desktop.clone();
            // Start visible: showing a hidden window during setup can leave
            // a subsequent WKWebView navigation hidden and its charts unpainted.
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("Trading Max · 工作区与连接")
                    .inner_size(1280.0, 840.0)
                    .min_inner_size(900.0, 640.0)
                    .center()
                    .visible(true)
                    .on_navigation(move |url| {
                        if internal_url(url)
                            || workspace_url(url, navigation.snapshot().active_url.as_deref())
                        {
                            return true;
                        }
                        open_external(url);
                        false
                    })
                    .on_new_window(|url, _| {
                        open_external(&url);
                        tauri::webview::NewWindowResponse::Deny
                    })
                    .on_page_load(move |window, payload| {
                        if payload.event() != tauri::webview::PageLoadEvent::Finished {
                            return;
                        }
                        let snapshot = pages.snapshot();
                        if workspace_url(payload.url(), snapshot.active_url.as_deref()) {
                            pages.update(snapshot.generation, |session| {
                                session.stage = "ready".into();
                                session.message = format!(
                                    "已连接{}",
                                    session.active_name.as_deref().unwrap_or("资料库")
                                );
                            });
                            if let Some(name) = snapshot.active_name {
                                let _ = window.set_title(&format!("Trading Max · {name}"));
                            }
                        }
                    })
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
            if autostart {
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
    #[test]
    fn native_commands_stay_local() {
        assert!(internal_url(
            &"tauri://localhost/index.html".parse().unwrap()
        ));
        for url in [
            "https://mini.example.test/",
            "http://127.0.0.1:43000/",
            "tauri://evil/index.html",
        ] {
            assert!(!internal_url(&url.parse().unwrap()));
        }
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
                generation: 0,
                stage: "idle".into(),
                message: String::new(),
                detail: String::new(),
                active_url: None,
                active_name: None,
                probe: None,
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
                generation: 0,
                stage: "idle".into(),
                message: String::new(),
                detail: String::new(),
                active_url: None,
                active_name: None,
                probe: None,
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
