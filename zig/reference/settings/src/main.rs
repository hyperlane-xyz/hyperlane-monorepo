//! Exact production role parsers. Run only in a disposable cwd with env_clear().
#[path = "../../../../rust/main/agents/scraper/src/settings.rs"]
mod scraper;
#[path = "../../../../rust/main/agents/validator/src/settings.rs"]
mod validator;
// Only the enum type is required by the included validator settings source.
mod checkpoint_consensus {
    #[derive(Debug, Clone, Copy)]
    pub enum CheckpointConsensus {
        Quorum,
        Majority,
    }
}
use hyperlane_base::{BaseAgent, LoadableFromSettings};
use serde_json::json;
fn base(s: &hyperlane_base::settings::Settings) -> serde_json::Value {
    let mut chains:Vec<_>=s.chains.values().map(|c|json!({"name":c.domain.name(),"domain":c.domain.id(),"protocol":format!("{:?}",c.domain.domain_protocol()),"technical_stack":format!("{:?}",c.domain.domain_technical_stack()).to_lowercase(),"confirmations":c.confirmations,"index_from":c.index.from,"index_chunk":c.index.chunk_size,"index_interval":c.index.idle_sleep_duration.as_secs()})).collect();
    chains.sort_by_key(|v| v["name"].as_str().unwrap().to_owned());
    json!({"metrics_port":s.metrics_port,"chains":chains})
}
fn main() {
    if std::env::args().nth(1).as_deref() == Some("--domain-stacks") {
        use std::io::Read;
        let mut input = String::new();
        std::io::stdin().read_to_string(&mut input).unwrap();
        let ids: Vec<u32> = serde_json::from_str(&input).unwrap();
        let values: Vec<_> = ids
            .into_iter()
            .map(|id| {
                let d = hyperlane_core::KnownHyperlaneDomain::try_from(id).unwrap();
                json!({"id":id,"stack":format!("{:?}",d.domain_technical_stack()).to_lowercase()})
            })
            .collect();
        println!("{}", serde_json::to_string(&values).unwrap());
        return;
    }
    let role = std::env::var("FIXTURE_ROLE").unwrap();
    let r: Result<serde_json::Value, String> = (|| {
        Ok(match role.as_str() {
            "validator" => {
                let s = validator::ValidatorSettings::load("validator").map_err(|_| "invalid")?;
                json!({"base":base(s.as_ref()),"interval":s.interval.as_secs(),"lightweight":s.lightweight,"allow_public_rpcs":s.allow_public_rpcs,"max_sign_concurrency":s.max_sign_concurrency,"rpc_count":s.rpcs.len()})
            }
            "scraper" => {
                let s = scraper::ScraperSettings::load("scraper").map_err(|_| "invalid")?;
                json!({"base":base(s.as_ref()),"db_max_connections":s.db_max_connections,"db_acquire_timeout_ms":s.db_acquire_timeout.as_millis()})
            }
            "relayer" => {
                let s = <relayer::Relayer as BaseAgent>::Settings::load("relayer")
                    .map_err(|_| "invalid")?;
                json!({"base":base(s.as_ref()),"max_message_retries":s.max_retries,"allow_local_checkpoint_syncers":s.allow_local_checkpoint_syncers,"allow_contract_call_caching":s.allow_contract_call_caching,"gas_policy_count":s.gas_payment_enforcement.len()})
            }
            _ => return Err("role".to_owned()),
        })
    })();
    println!(
        "{}",
        match r {
            Ok(v) => json!({"ok":true,"value":v}),
            Err(_) => json!({"ok":false}),
        }
    );
}
