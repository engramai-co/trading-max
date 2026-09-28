//! Service-owned auxiliary windows. These have no native capabilities and only
//! navigate within the selected service; normal links request presentation only.
use crate::{fit_webview, open_external, reveal_window, workspace_url, Desktop};
use std::sync::Arc;
use tauri::{Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub const LABELS: [&str; 3] = ["service-settings", "service-activity", "service-imports"];

pub fn presentation_url(mut url: Url) -> Url {
    let path = match url.path() {
        "/" => "/desktop".to_string(),
        "/health" => "/desktop/activity".to_string(),
        path if !path.starts_with("/desktop") => format!("/desktop{path}"),
        path => path.to_string(),
    };
    url.set_path(&path);
    url
}

fn panel(path: &str) -> Option<(&'static str, &'static str)> {
    match path {
        "/desktop/settings" | "/settings" => Some((LABELS[0], "工作区设置")),
        "/desktop/activity" | "/health" => Some((LABELS[1], "同步与活动")),
        "/desktop/imports" => Some((LABELS[2], "导入记录")),
        _ => None,
    }
}

pub fn allowed_link(url: &Url, address: &str) -> bool {
    workspace_url(url, Some(address))
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.path(),
            "/desktop"
                | "/desktop/holdings"
                | "/desktop/analytics"
                | "/desktop/research"
                | "/desktop/review"
                | "/desktop/account-analysis"
                | "/desktop/settings"
                | "/desktop/activity"
                | "/desktop/imports"
        )
}

pub fn close(app: &tauri::AppHandle) {
    for label in LABELS {
        if let Some(window) = app.get_webview_window(label) {
            let _ = window.destroy();
        }
    }
}

pub fn open(app: &tauri::AppHandle, desktop: &Arc<Desktop>, url: Url) -> Result<(), String> {
    let snapshot = desktop.snapshot();
    if snapshot.stage != "ready" || !workspace_url(&url, snapshot.active_url.as_deref()) {
        return Err("请先连接工作区。".into());
    }
    let Some((label, title)) = panel(url.path()) else {
        let window = app
            .get_webview_window("workspace")
            .ok_or("工作区尚未打开。")?;
        window.navigate(url).map_err(|e| e.to_string())?;
        return reveal_window(&window).map_err(|e| e.to_string());
    };
    if let Some(window) = app.get_webview_window(label) {
        // A repeated menu open preserves an unfinished form. A deliberate link
        // to another section carries query parameters and selects that section.
        if url.query().is_some() && window.url().ok().as_ref() != Some(&url) {
            window.navigate(url).map_err(|e| e.to_string())?;
        }
        return reveal_window(&window).map_err(|e| e.to_string());
    }
    let navigation = desktop.clone();
    let links = desktop.clone();
    let handle = app.clone();
    let generation = snapshot.generation;
    let owner = snapshot.active_name.as_deref().unwrap_or("工作区");
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title(format!("{title} · {owner}"))
        .inner_size(960.0, 780.0)
        .min_inner_size(680.0, 540.0)
        .center()
        .on_navigation(move |url| {
            let current = navigation.snapshot();
            if current.generation == generation && workspace_url(url, current.active_url.as_deref())
            {
                true
            } else {
                if current.generation == generation {
                    open_external(url);
                }
                false
            }
        })
        .on_new_window(move |url, _| {
            follow_link(&handle, &links, generation, url);
            tauri::webview::NewWindowResponse::Deny
        })
        .on_page_load(|window, _| {
            let _ = fit_webview(&window);
        })
        .build()
        .map_err(|e| e.to_string())?;
    reveal_window(&window).map_err(|e| e.to_string())
}

pub fn follow_link(app: &tauri::AppHandle, desktop: &Arc<Desktop>, generation: u64, url: Url) {
    let snapshot = desktop.snapshot();
    if snapshot.generation != generation || snapshot.stage != "ready" {
        return;
    }
    if snapshot.desktop_presentation
        && snapshot
            .active_url
            .as_deref()
            .is_some_and(|base| allowed_link(&url, base))
    {
        let handle = app.clone();
        let desktop = desktop.clone();
        let _ = app.run_on_main_thread(move || {
            if desktop.snapshot().generation == generation {
                let _ = open(&handle, &desktop, url);
            }
        });
    } else {
        open_external(&url);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn presentation_preserves_onboarding_and_filters() {
        let url = Url::parse("http://127.0.0.1:43123/settings?onboarding=1&tab=accounts").unwrap();
        let desktop = presentation_url(url.clone());
        assert_eq!(desktop.origin(), url.origin());
        assert_eq!(desktop.path(), "/desktop/settings");
        assert_eq!(desktop.query(), url.query());
        assert_eq!(presentation_url(desktop.clone()), desktop);
    }
    #[test]
    fn window_links_only_select_known_pages_on_the_current_origin() {
        let base = "https://mini.example.test/";
        for path in [
            "/desktop",
            "/desktop/settings?tab=models",
            "/desktop/activity?scope=cfd",
            "/desktop/imports",
        ] {
            assert!(allowed_link(
                &Url::parse(&format!("https://mini.example.test{path}")).unwrap(),
                base
            ));
        }
        for address in [
            "https://evil.test/desktop/settings",
            "https://mini.example.test/api/backend/refresh",
            "https://mini.example.test/desktop/unknown",
            "tauri://localhost/settings.html",
            "https://u:p@mini.example.test/desktop/settings",
            "http://127.0.0.1:43123/desktop/settings",
        ] {
            assert!(!allowed_link(&Url::parse(address).unwrap(), base));
        }
        assert!(!allowed_link(
            &Url::parse("http://127.0.0.1:43124/desktop/settings").unwrap(),
            "http://127.0.0.1:43123/"
        ));
    }
}
