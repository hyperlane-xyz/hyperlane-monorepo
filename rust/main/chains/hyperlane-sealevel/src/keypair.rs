use std::ops::Deref;

use solana_sdk::{signature::Keypair, signer::Signer};

/// Wrapper around solana_sdk's Keypair.
/// This implements a custom Debug so the private keys are
/// not exposed.
pub struct SealevelKeypair(pub Keypair);

impl SealevelKeypair {
    /// create new SealevelKeypair
    pub fn new(keypair: Keypair) -> Self {
        Self(keypair)
    }
    /// Return the underlying keypair
    pub fn keypair(&self) -> &Keypair {
        &self.0
    }
}

impl Deref for SealevelKeypair {
    type Target = Keypair;

    /// Return the underlying keypair
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl std::fmt::Debug for SealevelKeypair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0.pubkey())
    }
}

impl Default for SealevelKeypair {
    fn default() -> Self {
        Self(Keypair::new())
    }
}

#[cfg(test)]
mod test {
    use solana_sdk::signature::Keypair;

    use super::SealevelKeypair;

    #[test]
    fn test_no_exposed_secret_key() {
        let priv_key = "2ckDxzDFpZGeWd7VbHzd6dMgxYpqVDPA8XzeXFuuUJ1K8CjtyTBenD1TSPPovahXEFw3kBihoyAKktyro22MP4bN";
        let pub_key = "6oKnHXD2LRzQ4iNsgvkGSNNx68vj5GCYYpR2icy5JZhE";

        let keypair = SealevelKeypair(Keypair::from_base58_string(priv_key));

        let actual = format!("{:?}", keypair);
        assert_eq!(pub_key, actual);
    }
}
