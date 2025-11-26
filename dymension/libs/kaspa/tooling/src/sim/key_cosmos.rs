use hyperlane_core::AccountAddressType;
use hyperlane_cosmos::signers::Signer;
use k256::ecdsa::SigningKey as K256SigningKey;
use rand_core::OsRng;

#[derive(Clone)]
pub struct EasyHubKey {
    pub private: K256SigningKey,
}

impl EasyHubKey {
    pub fn new() -> Self {
        let hub_k = K256SigningKey::random(&mut OsRng);
        Self { private: hub_k }
    }
    pub fn signer(&self) -> Signer {
        let priv_k = self.private.to_bytes().to_vec();
        Signer::new(priv_k, "dym".to_string(), &AccountAddressType::Bitcoin).unwrap()
    }
    pub fn from_hex(hex: &str) -> Self {
        let priv_k = hex::decode(hex).unwrap();
        let hub_k = K256SigningKey::from_slice(&priv_k).unwrap();
        Self { private: hub_k }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_hub_key() {
        let hub_key = EasyHubKey::new();
        let signer = hub_key.signer();
        let addr = signer.address_string;
        let priv_k = hub_key.private.to_bytes().to_vec();
        let priv_k_hex = hex::encode(priv_k);
        println!("priv_k_hex: {}", priv_k_hex);
        println!("addr: {}", addr);
    }

    #[tokio::test]
    async fn test_round_trip_generate_hex_unhex() {
        let hub_key_0 = EasyHubKey::new();
        let priv_k = hub_key_0.private.to_bytes().to_vec();
        let priv_k_hex = hex::encode(priv_k);
        let hub_key_1 = EasyHubKey::from_hex(&priv_k_hex);
        assert_eq!(hub_key_0.private.to_bytes(), hub_key_1.private.to_bytes());
        assert_eq!(
            hub_key_0.signer().address_string,
            hub_key_1.signer().address_string
        );
    }
}
