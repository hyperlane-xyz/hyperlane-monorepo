use hyperlane_base::settings::{ChainConf, ChainConnectionConf};
use hyperlane_sealevel::ConnectionConf;

pub fn get_connection_conf(conf: &ChainConf) -> &ConnectionConf {
    match &conf.connection {
        ChainConnectionConf::Sealevel(connection_conf) => connection_conf,
        _ => panic!(),
    }
}
