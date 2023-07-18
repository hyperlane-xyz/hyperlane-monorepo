use std::env;

pub struct Config {
    pub is_ci_env: bool,
    pub ci_mode: bool,
    pub ci_mode_timeout: u64,
    pub kathy_messages: u64,
    pub log_all: bool,
}

impl Config {
    pub fn load() -> Self {
        let ci_mode = env::var("E2E_CI_MODE")
            .map(|k| k.parse::<bool>().unwrap())
            .unwrap_or_default();
        Self {
            is_ci_env: env::var("CI").as_deref() == Ok("true"),
            ci_mode,
            ci_mode_timeout: env::var("E2E_CI_TIMEOUT_SEC")
                .map(|k| k.parse::<u64>().unwrap())
                .unwrap_or(60 * 10),
            kathy_messages: {
                let r = env::var("E2E_KATHY_MESSAGES")
                    .ok()
                    .map(|r| r.parse::<u64>().unwrap());
                r.unwrap_or(16)
            },
            log_all: env::var("E2E_LOG_ALL")
                .map(|k| k.parse::<bool>().unwrap())
                .unwrap_or(ci_mode),
        }
    }
}
