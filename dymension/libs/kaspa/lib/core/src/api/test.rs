#[cfg(test)]
mod tests {
    use api_rs::apis::configuration;
    use api_rs::apis::kaspa_addresses_api::get_balance_from_kaspa_address_addresses_kaspa_address_balance_get;

    #[tokio::test]
    async fn test_get_balance_from_kaspa_address() {
        // let config = configuration::Configuration::new();
        let config = configuration::Configuration{
            base_path: "https://api-tn10.kaspa.org".to_string(),
            user_agent: Some("OpenAPI-Generator/a6a9569/rust".to_owned()),
            client: reqwest::Client::new(),
            basic_auth: None,
            oauth_access_token: None,
            bearer_access_token: None,
            api_key: None,
        };
        let addr = "kaspatest:qr0jmjgh2sx88q9gdegl449cuygp5rh6yarn5h9fh97whprvcsp2ksjkx456f"; // dan testnet
        let res = get_balance_from_kaspa_address_addresses_kaspa_address_balance_get(&config, addr)
            .await
            .unwrap();
        println!("res: {:?}", res);
    }
}
