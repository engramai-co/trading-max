fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let sdk = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("../vendor/sparkle")
            .canonicalize()
            .expect("Run: uv run python apps/desktop/scripts/prepare_sparkle.py");
        println!("cargo:rerun-if-changed=native/updater.m");
        println!("cargo:rerun-if-changed=native/chrome.m");
        println!("cargo:rerun-if-changed=Info.plist");
        cc::Build::new()
            .file("native/updater.m")
            .flag("-fobjc-arc")
            .flag("-mmacosx-version-min=13.0")
            .flag(format!("-F{}", sdk.display()))
            .compile("trading_max_updater");
        cc::Build::new()
            .file("native/chrome.m")
            .flag("-fobjc-arc")
            .flag("-mmacosx-version-min=13.0")
            .compile("trading_max_chrome");
        println!("cargo:rustc-link-lib=framework=Cocoa");
        println!("cargo:rustc-link-search=framework={}", sdk.display());
        println!("cargo:rustc-link-lib=framework=Sparkle");
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        // Unit-test executables are not inside an App. Never ship this development path.
        if std::env::var("PROFILE").as_deref() == Ok("debug") {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{}", sdk.display());
        }
    }
    tauri_build::build()
}
