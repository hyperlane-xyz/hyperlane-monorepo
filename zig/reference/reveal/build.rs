use std::{env, fs, path::PathBuf};
fn main() {
    let path = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../../rust/main/chains/hyperlane-sealevel/src/universal_router_reveal.rs");
    println!("cargo:rerun-if-changed={}", path.display());
    let text = fs::read_to_string(path).unwrap();
    let spans = [
        (
            "const RAYDIUM_CLMM_PROGRAM:",
            "async fn fetch_clmm_pool_state(",
        ),
        ("async fn fetch_clmm_pool_state(", "// Mirrors reveal.mjs"),
        (
            "#[allow(clippy::arithmetic_side_effects)]\nfn get_tick_array_start_index",
            "/// Configuration for automated UR reveal submission",
        ),
        (
            "#[derive(Deserialize, Debug)]\nstruct CcsGetResponse",
            "/// If `message` looks like a UR COMMIT",
        ),
        ("fn derive_fee_payer_pda(", "// PendingSwap layout"),
        ("async fn build_instruction(", "#[cfg(test)]\nmod tests"),
    ];
    let mut output = String::new();
    for (start, end) in spans {
        let begin = text.find(start).unwrap();
        let finish = begin + text[begin..].find(end).unwrap();
        output.push_str(&text[begin..finish]);
        output.push('\n');
    }
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("production.rs"),
        output,
    )
    .unwrap();
}
