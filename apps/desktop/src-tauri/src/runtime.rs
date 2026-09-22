use serde::{Deserialize, Serialize};
use std::os::unix::process::CommandExt;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Workspace {
    pub path: PathBuf,
    pub id: String,
    pub name: String,
}

struct OwnedRuntime {
    child: Child,
    root: PathBuf,
}

const MARKER: &str = "trading-max-desktop-preview-v1\n";

#[derive(Clone, Deserialize, Serialize)]
pub struct Status {
    pub stage: String,
    pub message: String,
    #[serde(default)]
    pub detail: String,
    #[serde(default)]
    pub web_url: Option<String>,
    #[serde(default)]
    pub supervisor_pid: u32,
}
impl Status {
    fn starting() -> Self {
        Self {
            stage: "starting".into(),
            message: "正在启动本机服务…".into(),
            detail: String::new(),
            web_url: None,
            supervisor_pid: 0,
        }
    }
    fn error(message: &str, detail: String) -> Self {
        Self {
            stage: "error".into(),
            message: message.into(),
            detail,
            web_url: None,
            supervisor_pid: 0,
        }
    }
}

pub struct Runtime {
    root: PathBuf,
    resources: PathBuf,
    child: Mutex<Option<OwnedRuntime>>,
    last: Mutex<Status>,
}

pub fn prepare_root(root: &Path) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let marker = root.join("DESKTOP_PREVIEW_ONLY");
    if marker.exists() {
        if fs::read_to_string(&marker).map_err(|e| e.to_string())? != MARKER {
            return Err("演示资料标记不匹配；未修改原有目录。".into());
        }
    } else {
        if fs::read_dir(root)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
        {
            return Err("资料目录中已有未识别的文件；未覆盖任何内容。".into());
        }
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(marker)
            .map_err(|e| e.to_string())?;
        file.write_all(MARKER.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(root.join("logs")).map_err(|e| e.to_string())?;
    Ok(())
}

impl Runtime {
    pub fn new(root: PathBuf, resources: PathBuf) -> Self {
        Self {
            root,
            resources,
            child: Mutex::new(None),
            last: Mutex::new(Status::starting()),
        }
    }
    pub fn workspace(&self, path: &Path, name: Option<&str>) -> Result<Workspace, String> {
        let mut command = Command::new(self.resources.join("python/bin/python3.12"));
        command
            .args(["-I", "-B", "-u"])
            .arg(self.resources.join("supervisor.py"))
            .arg(if name.is_some() {
                "workspace-create"
            } else {
                "workspace-inspect"
            })
            .arg("--state-root")
            .arg(path)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        if let Some(name) = name {
            command.arg("--name").arg(name);
        }
        let result = command.output().map_err(|_| "无法检查工作区。")?;
        let value: serde_json::Value = serde_json::from_slice(&result.stdout)
            .map_err(|_| "工作区检查未完成，原有资料未修改。")?;
        if !result.status.success() {
            return Err(value["error"]
                .as_str()
                .unwrap_or("无法打开工作区。")
                .to_string());
        }
        serde_json::from_value(value).map_err(|_| "工作区标记无法识别。".into())
    }
    pub fn start(&self, workspace: Option<&Workspace>) -> Result<(), String> {
        self.stop();
        prepare_root(&self.root)?;
        let root = workspace.map_or(&self.root, |w| &w.path);
        if let Some(workspace) = workspace {
            if self.workspace(root, None)? != *workspace {
                return Err("工作区已变化，请重新选择。".into());
            }
        }
        *self.last.lock().unwrap() = Status::starting();
        let log = fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(self.root.join("logs/launcher.log"))
            .map_err(|e| e.to_string())?;
        let mut cmd = Command::new(self.resources.join("python/bin/python3.12"));
        cmd.args(["-I", "-B", "-u"])
            .arg(self.resources.join("supervisor.py"))
            .arg("supervise")
            .arg("--state-root")
            .arg(root)
            .arg("--parent-pid")
            .arg(std::process::id().to_string())
            .current_dir(root)
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .env("LANG", "en_US.UTF-8")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log))
            .process_group(0);
        for key in ["HOME", "TMPDIR", "USER"] {
            if let Ok(value) = std::env::var(key) {
                cmd.env(key, value);
            }
        }
        if let Some(workspace) = workspace {
            cmd.arg("--workspace-id").arg(&workspace.id);
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("无法启动已打包的 Python：{e}"))?;
        *self.child.lock().unwrap() = Some(OwnedRuntime {
            child,
            root: root.clone(),
        });
        Ok(())
    }
    pub fn status(&self) -> Status {
        let mut holder = self.child.lock().unwrap();
        if let Some(owned) = holder.as_mut() {
            let child = &mut owned.child;
            if let Ok(text) = fs::read_to_string(owned.root.join("runtime-status.json")) {
                if let Ok(value) = serde_json::from_str::<Status>(&text) {
                    if value.supervisor_pid == child.id() {
                        *self.last.lock().unwrap() = value;
                    }
                }
            }
            if let Ok(Some(code)) = child.try_wait() {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGTERM);
                }
                let mut last = self.last.lock().unwrap();
                if last.stage != "error" {
                    *last = Status::error(
                        "本机服务已经停止，可以重新尝试。",
                        if code.code() == Some(73) {
                            "工作区已被另一个进程打开，请先关闭那个工作区。".into()
                        } else {
                            format!("服务退出：{code}。可检查本机工作区的 logs 文件夹。")
                        },
                    );
                }
                // Drop the reaped child so a later poll can never signal a reused PID.
                holder.take();
            }
        }
        self.last.lock().unwrap().clone()
    }
    pub fn stop(&self) {
        if let Some(mut owned) = self.child.lock().unwrap().take() {
            let child = &mut owned.child;
            let pid = child.id() as i32;
            // A dedicated group is created by us; never signal by name or port.
            unsafe {
                libc::kill(-pid, libc::SIGTERM);
            }
            let deadline = Instant::now() + Duration::from_secs(4);
            while Instant::now() < deadline {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                thread::sleep(Duration::from_millis(50));
            }
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
            let _ = child.wait();
        }
    }
}
