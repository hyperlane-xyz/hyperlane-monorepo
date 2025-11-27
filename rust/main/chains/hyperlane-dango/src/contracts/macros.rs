#[macro_export]
macro_rules! hyperlane_contract {
    ($contract:ident) => {
        impl hyperlane_core::HyperlaneContract for $contract {
            fn address(&self) -> H256 {
                self.address
            }
        }

        impl hyperlane_core::HyperlaneChain for $contract {
            fn domain(&self) -> &hyperlane_core::HyperlaneDomain {
                self.provider.domain()
            }

            fn provider(&self) -> Box<dyn hyperlane_core::HyperlaneProvider> {
                self.provider.provider()
            }
        }
    };
}
