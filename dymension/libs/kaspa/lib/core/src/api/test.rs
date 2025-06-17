use api_rs::apis::kaspa_addresses_api::get_balance_from_kaspa_address_addresses_kaspa_address_balance_get;
use api_rs::apis::configuration;
use api_rs::apis::models;

#[tokio::test]
async fn test_get_balance_from_kaspa_address() {
    let config = configuration::Configuration::new();

