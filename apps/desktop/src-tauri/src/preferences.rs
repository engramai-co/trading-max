use crate::connection::write_private_json;
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::Read,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

const LANGUAGE_FILE: &str = "app-language.json";

/// The App's language for text made away from a window, such as connection,
/// update and workspace errors. Chinese until the saved choice is read.
static ENGLISH: AtomicBool = AtomicBool::new(false);

/// A message in the App's current language.
pub fn tr(zh: &str, en: &str) -> String {
    AppLanguage::current().text(zh, en).to_string()
}

/// Whether messages with figures in them should use their English form.
pub fn english() -> bool {
    AppLanguage::current() == AppLanguage::English
}

/// Lets the native updater bridge name its errors in the App's language.
#[no_mangle]
pub extern "C" fn trading_max_english() -> bool {
    english()
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub enum AppLanguage {
    #[default]
    #[serde(rename = "zh-CN")]
    Chinese,
    #[serde(rename = "en")]
    English,
}

impl AppLanguage {
    pub fn read(root: &Path) -> Self {
        let mut bytes = Vec::new();
        File::open(root.join(LANGUAGE_FILE))
            .and_then(|file| file.take(64).read_to_end(&mut bytes))
            .ok()
            .filter(|&size| size < 64)
            .and_then(|_| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(self, root: &Path) -> Result<(), String> {
        write_private_json(root, LANGUAGE_FILE, &self)
    }

    /// Makes this the language of messages created from now on.
    pub fn set_current(self) {
        ENGLISH.store(self == Self::English, Ordering::Relaxed);
    }

    pub fn current() -> Self {
        if ENGLISH.load(Ordering::Relaxed) {
            Self::English
        } else {
            Self::Chinese
        }
    }

    pub fn text<'a>(self, zh: &'a str, en: &'a str) -> &'a str {
        match self {
            Self::Chinese => zh,
            Self::English => en,
        }
    }

    pub fn window_title(self, label: &str) -> &'static str {
        match label {
            "settings" => self.text("Trading Max · 设置", "Trading Max · Settings"),
            "workspaces" => self.text("Trading Max · 工作区", "Trading Max · Workspaces"),
            _ => self.text(
                "Trading Max · 工作区与连接",
                "Trading Max · Workspaces and connections",
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_language_defaults_to_chinese_and_persists_explicit_choices() {
        let root = std::env::temp_dir().join(format!(
            "tm-app-language-{}-{}",
            std::process::id(),
            crate::connection::now_ms()
        ));
        assert_eq!(AppLanguage::read(&root), AppLanguage::Chinese);
        assert!(!root.exists());
        for language in [AppLanguage::English, AppLanguage::Chinese] {
            language.save(&root).unwrap();
            assert_eq!(AppLanguage::read(&root), language);
        }
        std::fs::write(root.join(LANGUAGE_FILE), br#""en-GB""#).unwrap();
        assert_eq!(AppLanguage::read(&root), AppLanguage::Chinese);
        std::fs::remove_dir_all(root).unwrap();
    }
}
