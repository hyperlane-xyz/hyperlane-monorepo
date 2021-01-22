mod abis;
mod settings;

use optics_core::traits::{Home, Replica};

#[derive(Debug)]
struct App {
    home: Box<dyn Home>,
    replicas: Vec<Box<dyn Replica>>,
}

async fn _main(settings: settings::Settings) {
    println!("{:?}", &settings);

    let app = App {
        home: settings.home.try_into_home().await.expect("!home"),
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
