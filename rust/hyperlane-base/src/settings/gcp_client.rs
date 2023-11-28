use cloud_storage::Client;

pub(crate) struct GoogleCloudClientProvider {
    pub cli: Client,
    default: bool,
}

impl Clone for GoogleCloudClientProvider {
    fn clone(&self) -> Self {
        let cli = match self.default {
            true => Client::default(),
            false => Client::new(),
        };
        GoogleCloudClientProvider {
            cli,
            default: self.default,
        }
    }
}

impl GoogleCloudClientProvider {
    pub fn new() -> Self {
        GoogleCloudClientProvider {
            cli: Client::default(),
            default: true,
        }
    }

    pub fn new_with_credentials() -> Self {
        GoogleCloudClientProvider {
            cli: Client::new(),
            default: false,
        }
    }
}
