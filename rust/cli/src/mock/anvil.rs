use ethers::utils::AnvilInstance;
use std::{
    fmt::{self, Debug, Formatter},
    ops::{Deref, DerefMut},
};

/// Wrapper for AnvilInstance that implements Debug.
pub struct AnvilInstanceWrapper(pub AnvilInstance);

impl Deref for AnvilInstanceWrapper {
    type Target = AnvilInstance;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl DerefMut for AnvilInstanceWrapper {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

impl Debug for AnvilInstanceWrapper {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.debug_struct("AnvilInstanceWrapper")
            .field("chain_id", &self.chain_id())
            .finish()
    }
}
