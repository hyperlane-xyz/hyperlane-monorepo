// see terminal output
// cargo test -- --nocapture

#[cfg(test)]
mod tests {
    use crate::api::client::HttpClient;
    use eyre::Result;

    use api_rs::apis::kaspa_addresses_api::*;
    use api_rs::apis::kaspa_transactions_api::*;

    use crate::api::base::RateLimitConfig;

    const DAN_TESTNET_ADDR: &str =
        "kaspatest:qq3r5cj2r3a7kfne7wwwcf0n8kc8e5y3cy2xgm2tcuqygs4lrktswcc3d9l3p";

    fn t_client() -> HttpClient {
        HttpClient::new(
            "https://api-tn10.kaspa.org/".to_string(),
            RateLimitConfig::default(),
        )
    }

    #[tokio::test]
    #[ignore = "dont hit real api"]
    async fn test_balance() {
        let client = t_client();
        let config = client.get_config();
        let addr = DAN_TESTNET_ADDR;
        let res = get_balance_from_kaspa_address_addresses_kaspa_address_balance_get(
            &config,
            GetBalanceFromKaspaAddressAddressesKaspaAddressBalanceGetParams {
                kaspa_address: addr.to_string(),
            },
        )
        .await
        .unwrap();
        println!("res: {:?}", res);
    }

    #[tokio::test]
    #[ignore = "dont hit real api"]
    async fn test_txs() {
        let client = t_client();
        let config = client.get_config();
        let addr = DAN_TESTNET_ADDR;
        let limit = Some(10);
        let field = None;
        // let resolve_previous_outpoints = None;
        let resolve_previous_outpoints = Some("no".to_string());
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
        // let lower_bound = Some(0i64);
        // let upper_bound = Some(0i64);
        let lower_bound = None;
        let upper_bound = None;

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
            GetFullTransactionsForAddressPageAddressesKaspaAddressFullTransactionsPageGetParams {
                kaspa_address: addr.to_string(),
                limit: limit,
                before: lower_bound,
                after: upper_bound,
                fields: field,
                resolve_previous_outpoints: resolve_previous_outpoints,
                acceptance: acceptance,
            },
        )
        .await
        .unwrap();
        println!("res: {:?}", res);
    }

    #[tokio::test]
    #[ignore = "dont hit real api"]
    async fn test_tx_by_id() {
        let client = t_client();
        let config = client.get_config();
        let tx_id = "1ffa672605af17906d99ba9506dd49406a2e8a3faa2969ab0c8929373aca51d1";
        let tx = get_transaction_transactions_transaction_id_get(
            &config,
            GetTransactionTransactionsTransactionIdGetParams {
                transaction_id: tx_id.to_string(),
                block_hash: None,
                inputs: Some(true),
                outputs: Some(true),
                resolve_previous_outpoints: Some("light".to_string()),
            },
        )
        .await
        .unwrap();
        println!("tx: {:?}", tx);
    }

    #[tokio::test]
    #[ignore = "dont hit real api"]
    async fn test_get_deposits() {
        // https://explorer-tn10.kaspa.org/addresses/kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr?page=1
        let client = t_client();
        let address = "kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr";

        let deposits = client
            .get_deposits_by_address(
                Some(1751299515650),
                address,
                hardcode::hl::HL_DOMAIN_KASPA_TEST10,
            )
            .await;

        match deposits {
            Ok(deposits) => {
                println!("Found deposits: n = {:?}", deposits.len());
                for deposit in deposits {
                    println!("Deposit: {:?}", deposit);
                }
            }
            Err(e) => {
                println!("Query deposits: {:?}", e);
            }
        }
    }

    #[tokio::test]
    #[ignore = "dont hit real api"]
    async fn test_get_tx_by_id() -> Result<()> {
        let client = t_client();

        let tx_id = "49601485182fa057b000d18993db7756fc5a58823c47b64495d5532add38d2ea";
        let tx = client
            .get_tx_by_id(tx_id)
            .await
            .map_err(|e| eyre::eyre!(e))?;

        println!("Tx: {:?}", tx);

        let addr = tx
            .outputs
            .ok_or(eyre::eyre!("Tx has no outputs"))?
            .first()
            .ok_or(eyre::eyre!("Tx has no outputs"))?
            .clone()
            .script_public_key_address
            .ok_or(eyre::eyre!("Tx output has no script public key address"))?;

        assert!(kaspa_addresses::Address::validate(addr.as_str()));

        Ok(())
    }
}
