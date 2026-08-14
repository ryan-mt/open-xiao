fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons-beta/icon.ico");
    tauri_build::build()
}
