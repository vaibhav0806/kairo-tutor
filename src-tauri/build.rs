fn main() {
    // SHOW_IN_CAPTURE is a compile-time const overridden by KAIRO_SHOW_IN_CAPTURE
    // (see constants.rs). `option_env!` reads it at build time, but Cargo won't
    // recompile on a change unless we declare it here — so a dev build (true) and the
    // production DMG build (false) reliably bake the right value.
    println!("cargo:rerun-if-env-changed=KAIRO_SHOW_IN_CAPTURE");
    tauri_build::build();
}
