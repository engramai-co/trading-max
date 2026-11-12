use crate::connection::write_private_json;
use serde::{Deserialize, Serialize};
use std::{fs::File, io::Read, path::Path};

const LANGUAGE_FILE: &str = "app-language.json";

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
