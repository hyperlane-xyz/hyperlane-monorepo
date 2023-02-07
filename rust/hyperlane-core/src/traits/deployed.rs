use crate::{HyperlaneDomain, HyperlaneProvider, H256};
use std::fmt;

/// Interface for features of something deployed on/in a domain or is otherwise
/// connected to it.
#[auto_impl::auto_impl(Box, Arc)]
pub trait HyperlaneChain {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain;
    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider>;
}

/// Interface for a deployed contract.
/// This trait is intended to expose attributes of any contract, and
/// should not consider the purpose or implementation details of the contract.
#[auto_impl::auto_impl(Box, Arc)]
pub trait HyperlaneContract: HyperlaneChain {
    /// Return the address of this contract.
    fn address(&self) -> H256;
}

/// Static contract ABI information.
#[auto_impl::auto_impl(Box, Arc)]
pub trait HyperlaneAbi {
    /// Size of the returned selector byte arrays.
    const SELECTOR_SIZE_BYTES: usize;

    /// Get a mapping from function selectors to human readable function names.
    fn fn_map() -> std::collections::HashMap<Vec<u8>, &'static str>;

    /// Get a mapping from function selectors to owned human readable function
    /// names.
    fn fn_map_owned() -> std::collections::HashMap<Vec<u8>, String> {
        Self::fn_map()
            .into_iter()
            .map(|(sig, name)| (sig, name.to_owned()))
            .collect()
    }
}

impl fmt::Debug for dyn HyperlaneChain {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let domain = self.domain();
        write!(f, "HyperlaneChain({} ({}))", domain, domain.id())
    }
}

impl fmt::Debug for dyn HyperlaneContract {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let domain = self.domain();
        write!(
            f,
            "HyperlaneContract({:?} @ {} ({}))",
            self.address(),
            domain,
            domain.id(),
        )
    }
}
