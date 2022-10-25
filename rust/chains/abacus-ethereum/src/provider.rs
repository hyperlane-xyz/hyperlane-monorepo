use std::sync::Arc;

use ethers::prelude::Middleware;

use abacus_core::AbacusChain;

pub struct EthereumProvider<M>
where
    M: Middleware,
{
    provider: Arc<M>,
}

impl<M> AbacusChain for EthereumProvider<M>
where
    M: Middleware + 'static,
{
    fn chain_name(&self) -> &str {
        todo!()
    }

    fn local_domain(&self) -> u32 {
        todo!()
    }
}
