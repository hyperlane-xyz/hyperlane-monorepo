mod abis;
mod settings;

use ethers_providers::{Http, Provider};
// use std::collections::HashMap;
use std::{convert::TryFrom, sync::Arc};

use optics_core::traits::{Home, Replica};

#[derive(Debug)]
struct App {
    home: Box<dyn Home>,
    replicas: Vec<Box<dyn Replica>>,
}

async fn _main(settings: settings::Settings) {
    println!("{:?}", &settings);

    let home = {
        let provider = Arc::new(Provider::<Http>::try_from(settings.home().url()).expect("!url"));
        Box::new(abis::HomeContract::at(
            0,
            settings.home().address().into(),
            provider,
        ))
    };

    let app = App {
        home,
        replicas: vec![],
    };
    println!("{:?}", &app);
}

fn main() {
    let settings = settings::Settings::new().expect("!config");

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(_main(settings))
}
