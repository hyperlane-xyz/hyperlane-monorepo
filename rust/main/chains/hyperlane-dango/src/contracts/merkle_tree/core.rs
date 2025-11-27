use {
    crate::{
        hyperlane_contract, ConnectionConf, DangoConvertor, DangoError, DangoProvider, DangoResult,
        DangoSigner, TryDangoConvertor,
    },
    anyhow::anyhow,
    async_trait::async_trait,
    dango_hyperlane_types::{
        mailbox::QueryTreeRequest,
        IncrementalMerkleTree as DangoIncrementalMerkleTree,
    },
    grug::{QueryClientExt, QueryResponse},
    hyperlane_core::{
        accumulator::incremental::IncrementalMerkle, ChainCommunicationError, ChainResult,
        Checkpoint, CheckpointAtBlock, ContractLocator, HyperlaneContract,
        IncrementalMerkleAtBlock, MerkleTreeHook, ReorgPeriod, H256,
    },
    std::fmt::Display,
};

#[derive(Debug)]
pub struct DangoMerkleTree {
    pub(crate) address: H256,
    pub(crate) provider: DangoProvider,
}

hyperlane_contract!(DangoMerkleTree);

#[async_trait]
impl MerkleTreeHook for DangoMerkleTree {
    async fn tree(&self, reorg_period: &ReorgPeriod) -> ChainResult<IncrementalMerkleAtBlock> {
        self.provider.validate_reorg_period(reorg_period).await?;
        let (dango_tree, block_height) = self.dango_tree_with_height().await?;

        let tree = IncrementalMerkle::new(
            dango_tree
                .branch
                .into_iter()
                .map(|hash| hash.convert())
                .collect::<Vec<H256>>()
                .try_into()
                .map_err(|_| ChainCommunicationError::ParseError {
                    msg: "Failed to build merkle branch array".to_string(),
                })?,
            dango_tree.count as usize,
        );

        Ok(IncrementalMerkleAtBlock {
            tree,
            block_height: block_height.into(),
        })
    }

    #[tracing::instrument("merkle_tree_hook::count", skip_all)]
    async fn count(&self, reorg_period: &ReorgPeriod) -> ChainResult<u32> {
        self.provider.validate_reorg_period(reorg_period).await?;
        Ok(self.dango_tree().await?.count as u32)
    }

    async fn latest_checkpoint(
        &self,
        reorg_period: &ReorgPeriod,
    ) -> ChainResult<CheckpointAtBlock> {
        self.provider.validate_reorg_period(reorg_period).await?;
        let (dango_tree, block_height) = self.dango_tree_with_height().await?;
        let index = if dango_tree.count == 0 {
            0
        } else {
            dango_tree.count - 1
        };

        Ok(CheckpointAtBlock {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: self.address(),
                mailbox_domain: self.provider.domain.id(),
                root: dango_tree.root().convert(),
                index: index as u32,
            },
            block_height: Some(block_height),
        })
    }

    async fn latest_checkpoint_at_block(&self, _height: u64) -> ChainResult<CheckpointAtBlock> {
        // TODO: We don't support querying at a specific block height

        Err(DangoError::QueryingAtSpecificBlockHeightNotSupported.into())

        // let addr = self.address.try_convert()?;
        // let res = self
        //     .provider
        //     .query_multi(
        //         [
        //             Query::wasm_smart(addr, &mailbox::QueryMsg::Nonce {})?,
        //             Query::wasm_smart(addr, &mailbox::QueryMsg::Tree {})?,
        //             Query::status(),
        //         ],
        //         None,
        //     )
        //     .await?;

        // let [nonce, tree, status] = parse_response(res)?;
        // let nonce: u32 = nonce.as_wasm_smart().deserialize_json()?;
        // let tree: DangoIncrementalMerkleTree = tree.as_wasm_smart().deserialize_json()?;

        // Ok(CheckpointAtBlock {
        //     checkpoint: Checkpoint {
        //         merkle_tree_hook_address: self.address(),
        //         mailbox_domain: self.provider.domain.id(),
        //         root: tree.root().convert(),
        //         index: nonce,
        //     },
        //     block_height: Some(status.as_status().last_finalized_block.height),
        // })
    }
}

#[allow(clippy::manual_try_fold)]
fn _parse_response<E: Display, const N: usize>(
    res: [Result<QueryResponse, E>; N],
) -> ChainResult<[QueryResponse; N]> {
    res.into_iter()
        .enumerate()
        .fold(Ok(vec![]), |acc, (i, res)| match (acc, res) {
            (Ok(mut acc), Ok(res)) => {
                acc.push(res);
                Ok(acc)
            }
            (Ok(_), Err(err)) => Err(vec![format!("index: {i} - {err}")]),
            (Err(acc), Ok(_)) => Err(acc),
            (Err(mut acc), Err(err)) => {
                acc.push(format!("index: {i} - {err}"));
                Err(acc)
            }
        })
        .map_err(|err| anyhow!("{:#?}", err).into())
        // safe unwrap because we know that the length of the array is the same as the number of results
        .map(|a| a.try_into().unwrap())
}

impl DangoMerkleTree {
    pub fn new(
        config: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<DangoSigner>,
    ) -> DangoResult<Self> {
        Ok(Self {
            provider: DangoProvider::from_config(config, locator.domain, signer)?,
            address: locator.address,
        })
    }

    pub async fn dango_tree(&self) -> ChainResult<DangoIncrementalMerkleTree> {
        self.provider
            .query_wasm_smart(self.address.try_convert()?, QueryTreeRequest {}, None)
            .await
    }

    pub async fn dango_tree_with_height(&self) -> ChainResult<(DangoIncrementalMerkleTree, u64)> {
        self.provider
            .query_wasm_smart_with_height(self.address.try_convert()?, QueryTreeRequest {})
            .await
    }
}
