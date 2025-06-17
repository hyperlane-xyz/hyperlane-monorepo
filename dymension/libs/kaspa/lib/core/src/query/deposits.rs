use tracing::{debug, error, info, info_span, warn, Instrument};

pub struct Deposit {
}

pub fn get_deposits() -> Vec<Deposit> {
    info!("FOOBAR get_deposits");
    unimplemented!()
}

#[derive(Debug)]
pub struct HttpClient{
    client: reqwest::Client,

}

impl HttpClient {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}


