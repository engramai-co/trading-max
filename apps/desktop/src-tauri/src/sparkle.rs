//! The trusted native entry can open Sparkle; remote WebViews cannot reach this bridge.
use crate::{connection, updates::UpdateFeed, Desktop};
#[cfg(target_os = "macos")]
use std::ffi::CString;
use std::{sync::atomic::Ordering, sync::Arc, sync::OnceLock};
use tauri::{AppHandle, Manager};

static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn initialize(app: AppHandle) {
    let _ = APP.set(app);
}

#[no_mangle]
extern "C" fn trading_max_prepare_update() {
    if let Some(app) = APP.get() {
        let desktop = app.state::<Arc<Desktop>>();
        let snapshot = desktop.snapshot();
        if let Some(profile) = snapshot.desired {
            // One-use source selection; do not change the saved auto-open preference.
            let _ = connection::write_private_json(&desktop.root, "update-reopen.json", &profile);
        }
        desktop.exiting.store(true, Ordering::Relaxed);
        desktop.runtime.stop();
    }
}

/// Called on Tauri's main thread, after the official release was revalidated.
pub fn start(feed: UpdateFeed) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn trading_max_start_update(
                feed: *const std::ffi::c_char,
                version: *const std::ffi::c_char,
                archive: *const std::ffi::c_char,
                size: u64,
            ) -> *const std::ffi::c_char;
        }
        let url = CString::new(feed.url).map_err(|_| "更新地址无效。")?;
        let version = CString::new(feed.version).map_err(|_| "更新版本无效。")?;
        let archive = CString::new(feed.archive).map_err(|_| "安装包地址无效。")?;
        // All strings live through the synchronous call; the bridge copies them.
        let error = unsafe {
            trading_max_start_update(url.as_ptr(), version.as_ptr(), archive.as_ptr(), feed.size)
        };
        if !error.is_null() {
            return Err(unsafe { std::ffi::CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = feed;
        Err("App 内更新目前仅适用于 macOS。".into())
    }
}

pub fn take_reopen(root: &std::path::Path) -> Option<connection::Profile> {
    let path = root.join("update-reopen.json");
    let metadata = std::fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > 8192 {
        let _ = std::fs::remove_file(path);
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    // Consume once even when invalid; a stale intent must not override future launches.
    std::fs::remove_file(path).ok()?;
    if bytes.len() > 8192 {
        return None;
    }
    serde_json::from_slice::<connection::Profile>(&bytes)
        .ok()?
        .validated()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_intent_is_one_use_and_does_not_change_saved_preferences() {
        let root = std::env::temp_dir().join(format!(
            "tm-update-{}-{}",
            std::process::id(),
            connection::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let profile = connection::Profile {
            url: "https://example.com/".into(),
            auto_connect: false,
            ..Default::default()
        };
        connection::write_private_json(&root, "update-reopen.json", &profile).unwrap();
        std::fs::write(root.join("connection.json"), b"saved preference").unwrap();
        assert_eq!(take_reopen(&root), Some(profile));
        assert!(take_reopen(&root).is_none());
        assert_eq!(
            std::fs::read(root.join("connection.json")).unwrap(),
            b"saved preference"
        );
        std::fs::write(root.join("update-reopen.json"), vec![b'x'; 8193]).unwrap();
        assert!(take_reopen(&root).is_none());
        std::os::unix::fs::symlink(
            root.join("connection.json"),
            root.join("update-reopen.json"),
        )
        .unwrap();
        assert!(take_reopen(&root).is_none());
        assert!(root.join("connection.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
