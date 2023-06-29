use std::env::current_dir;

fn main() {
    Patcher::default()
        .working_dir(current_dir().unwrap())
        .repo_url("https://github.com/solana-labs/solana")
        .repo_tag(&format!("v{}", env!("CARGO_PKG_VERSION")))
        .patch_with("tokio.patch")
        .patch_with("aes-gcm-siv.patch")
        .clone_dir("solana")
        .run();
}
