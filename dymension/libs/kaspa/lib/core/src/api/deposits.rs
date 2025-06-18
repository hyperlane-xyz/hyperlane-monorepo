use tracing::{debug, error, info, info_span, warn, Instrument};

use url::Url;

use api_rs::apis::configuration::Configuration;

pub struct Deposit {}

pub fn get_deposits() -> Vec<Deposit> {
    info!("FOOBAR get_deposits");
    unimplemented!()
}

#[derive(Debug)]
pub struct HttpClient {
    url: Url,
    client: reqwest::Client,
}

impl HttpClient {
    pub fn new(url: Url) -> Self {
        Self {
            url,
            client: reqwest::Client::new(),
        }
    }

    fn get_config(&self) -> Configuration {
        Configuration {
            base_path: self.url.to_string(),
            user_agent: Some("OpenAPI-Generator/a6a9569/rust".to_owned()),
            client: self.client,
            basic_auth: None,
            oauth_access_token: None,
            bearer_access_token: None,
            api_key: None,
        }
    }

    pub async fn get_deposits(&self) -> Vec<Deposit> {
        let url = self.url.join("/api/v1/deposits").unwrap();
        let res = self.client.get(url).send().await.unwrap();
        let body = res.text().await.unwrap();
        println!("body: {:?}", body);
        vec![]
    }
}
