// see terminal output
// cargo test -- --nocapture

#[cfg(test)]
mod tests {
    use api_rs::apis::configuration;
    use api_rs::apis::kaspa_addresses_api::*;
    use tracing::info;

    fn get_config() -> configuration::Configuration {
        configuration::Configuration {
            base_path: "https://api-tn10.kaspa.org".to_string(),
            user_agent: Some("OpenAPI-Generator/a6a9569/rust".to_owned()),
            client: reqwest::Client::new(),
            basic_auth: None,
            oauth_access_token: None,
            bearer_access_token: None,
            api_key: None,
        }
    }

    const DAN_TESTNET_ADDR: &str =
        "kaspatest:qr0jmjgh2sx88q9gdegl449cuygp5rh6yarn5h9fh97whprvcsp2ksjkx456f";

    #[tokio::test]
    async fn test_balance() {
        let config = get_config();
        let addr = DAN_TESTNET_ADDR;
        let res = get_balance_from_kaspa_address_addresses_kaspa_address_balance_get(&config, addr)
            .await
            .unwrap();
        println!("res: {:?}", res);
    }

    #[tokio::test]
    async fn test_txs() {
        let config = get_config();
        let addr = DAN_TESTNET_ADDR;
        let limit = Some(10);
        let field = None;
        // let resolve_previous_outpoints = None;
        let resolve_previous_outpoints = Some("no");
        let acceptance = None;
        // https://explorer-tn10.kaspa.org/addresses/kaspatest:qr0jmjgh2sx88q9gdegl449cuygp5rh6yarn5h9fh97whprvcsp2ksjkx456f?page=1
        // 2025-06-10 16:23:29 UTC is 1749505409
        // 2025-06-10 17:18:20 UTC is 1749508700
        // add 10 sec buffers
        // Lower Bound: 1749505399
        // Upper Bound: 1749508710
        // let lower_bound = Some(1i32);
        // let lower_bound = Some(1749505399i32);
        // let upper_bound = Some(1749508710i32);
        let lower_bound = Some(0i64);
        let upper_bound = Some(0i64);

        // 1 749 572 304 176
        // let upper_bound = None;

        // TODO: i checked and this query indeed finds TXs which are DEPOSITS (as well as spends)
        /*
              Explorer example
                  curl 'https://api-tn10.kaspa.org/addresses/kaspatest:qq3r5cj2r3a7kfne7wwwcf0n8kc8e5y3cy2xgm2tcuqygs4lrktswcc3d9l3p/full-transactions?limit=20&offset=0' \
        -H 'accept: ...' \
        -H 'accept-language: en-GB-oxendict,en;q=0.6' \
        -H 'access-control-allow-origin: *' \
        -H 'content-type: application/json' \
        -H 'if-modified-since: Tue, 17 Jun 2025 16:08:14 GMT' \
        -H 'origin: https://explorer-tn10.kaspa.org' \
        -H 'priority: u=1, i' \
        -H 'referer: https://explorer-tn10.kaspa.org/' \
        -H 'sec-ch-ua: "Chromium";v="136", "Brave";v="136", "Not.A/Brand";v="99"' \
        -H 'sec-ch-ua-mobile: ?0' \
        -H 'sec-ch-ua-platform: "macOS"' \
        -H 'sec-fetch-dest: empty' \
        -H 'sec-fetch-mode: cors' \
        -H 'sec-fetch-site: same-site' \
        -H 'sec-gpc: 1' \
        -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
               */

        let res = get_full_transactions_for_address_page_addresses_kaspa_address_full_transactions_page_get(
            &config,
            addr,
            limit,
            lower_bound,
            upper_bound,
            field,
            resolve_previous_outpoints,
            acceptance,
        )
        .await
        .unwrap();
        println!("res: {:?}", res);
    }
}
