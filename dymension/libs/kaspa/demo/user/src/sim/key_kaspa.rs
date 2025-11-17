use kaspa_addresses::{Address, Prefix, Version};
use secp256k1::{Keypair, Secp256k1};

pub struct EasyKaspaKey {
    pub address: Address,
}

pub fn get_kaspa_keypair() -> EasyKaspaKey {
    let secp = Secp256k1::new();
    let mut rng = rand_08::thread_rng();
    let keypair = Keypair::new(&secp, &mut rng);
    let pub_key = keypair.public_key().x_only_public_key().0;
    let address = Address::new(Prefix::Testnet, Version::PubKey, &pub_key.serialize());
    EasyKaspaKey { address }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_kaspa_keypair_print_address() {
        let key = get_kaspa_keypair();
        println!("{}", key.address);
    }
}
