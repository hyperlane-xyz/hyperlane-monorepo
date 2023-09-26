#![allow(warnings)] // FIXME remove

use std::{collections::HashMap, num::NonZeroU64, str::FromStr as _};

use async_trait::async_trait;
use borsh::{BorshDeserialize, BorshSerialize};
use jsonrpc_core::futures_util::TryFutureExt;
use tracing::{debug, info, instrument, warn};

use hyperlane_core::{
    accumulator::incremental::IncrementalMerkle,
    ChainCommunicationError, ChainResult, Checkpoint, ContractLocator, Decode as _, Encode as _,
    HyperlaneAbi, HyperlaneChain, HyperlaneContract, HyperlaneDomain, HyperlaneMessage,
    HyperlaneProvider,
    IndexRange::{self, BlockRange},
    Indexer, LogMeta, Mailbox, MessageIndexer, SequenceRange, TxCostEstimate, TxOutcome, H256,
    H512, U256,
};

use crate::{utils, AptosHpProvider, ConnectionConf};

use solana_sdk::signature::Keypair;

use crate::types::{DispatchEventData, MoveMerkleTree};
use crate::utils::{convert_addr_string_to_h256, send_aptos_transaction};
use crate::AptosClient;

use aptos_sdk::{
    crypto::ed25519::Ed25519PrivateKey,
    crypto::ed25519::Ed25519PublicKey,
    move_types::{ident_str, language_storage::ModuleId},
    rest_client::{
        aptos_api_types::{EntryFunctionId, VersionedEvent, ViewRequest},
        Client, FaucetClient,
    },
    transaction_builder::TransactionFactory,
    types::transaction::authenticator::AuthenticationKey,
    types::AccountKey,
    types::LocalAccount,
    types::{
        account_address::AccountAddress,
        chain_id::ChainId,
        transaction::{EntryFunction, TransactionPayload},
    },
};

/// A reference to a Mailbox contract on some Aptos chain
pub struct AptosMailbox {
    domain: HyperlaneDomain,
    payer: Option<Keypair>,
    aptos_client: AptosClient,
    package_address: AccountAddress,
}

impl AptosMailbox {
    /// Create a new Aptos mailbox
    pub fn new(
        conf: &ConnectionConf,
        locator: ContractLocator,
        payer: Option<Keypair>,
    ) -> ChainResult<Self> {
        let domain = locator.domain.id();
        let package_address =
            AccountAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        let aptos_client = AptosClient::new(conf.url.to_string());

        Ok(AptosMailbox {
            domain: locator.domain.clone(),
            payer,
            package_address,
            aptos_client,
        })
    }
}

impl HyperlaneContract for AptosMailbox {
    fn address(&self) -> H256 {
        self.package_address.into_bytes().into()
    }
}

impl HyperlaneChain for AptosMailbox {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(AptosHpProvider::new(self.domain.clone()))
    }
}

impl std::fmt::Debug for AptosMailbox {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}", self as &dyn HyperlaneContract)
    }
}

#[async_trait]
impl Mailbox for AptosMailbox {
    #[instrument(err, ret, skip(self))]
    async fn count(&self, _maybe_lag: Option<NonZeroU64>) -> ChainResult<u32> {
        let view_response = utils::send_view_request(
            &self.aptos_client,
            self.package_address.to_hex_literal(),
            "mailbox".to_string(),
            "outbox_get_count".to_string(),
            vec![],
            vec![],
        )
        .await?;
        let view_result = serde_json::from_str::<u32>(&view_response[0].to_string()).unwrap();
        Ok(view_result)
    }

    #[instrument(err, ret, skip(self))]
    async fn delivered(&self, id: H256) -> ChainResult<bool> {
        let view_response = utils::send_view_request(
            &self.aptos_client,
            self.package_address.to_hex_literal(),
            "mailbox".to_string(),
            "delivered".to_string(),
            vec![],
            vec![serde_json::json!(hex::encode(id.as_bytes()))],
        )
        .await?;
        let view_result = serde_json::from_str::<bool>(&view_response[0].to_string()).unwrap();
        Ok(view_result)
    }

    #[instrument(err, ret, skip(self))]
    async fn tree(&self, lag: Option<NonZeroU64>) -> ChainResult<IncrementalMerkle> {
        let view_response = utils::send_view_request(
            &self.aptos_client,
            self.package_address.to_hex_literal(),
            "mailbox".to_string(),
            "outbox_get_tree".to_string(),
            vec![],
            vec![],
        )
        .await?;
        let view_result =
            serde_json::from_str::<MoveMerkleTree>(&view_response[0].to_string()).unwrap();
        Ok(view_result.into())
    }

    #[instrument(err, ret, skip(self))]
    async fn latest_checkpoint(&self, lag: Option<NonZeroU64>) -> ChainResult<Checkpoint> {
        let tree = self.tree(lag).await?;

        let root = tree.root();
        let count: u32 = tree
            .count()
            .try_into()
            .map_err(ChainCommunicationError::from_other)?;
        let index = count.checked_sub(1).ok_or_else(|| {
            ChainCommunicationError::from_contract_error_str(
                "Outbox is empty, cannot compute checkpoint",
            )
        })?;

        let checkpoint = Checkpoint {
            mailbox_address: H256::from_str(&self.package_address.to_hex()).unwrap(),
            mailbox_domain: self.domain.id(),
            root,
            index,
        };
        Ok(checkpoint)
    }

    #[instrument(err, ret, skip(self))]
    async fn default_ism(&self) -> ChainResult<H256> {
        let view_response = utils::send_view_request(
            &self.aptos_client,
            self.package_address.to_hex_literal(),
            "mailbox".to_string(),
            "get_default_ism".to_string(),
            vec![],
            vec![],
        )
        .await?;

        let ism_address = serde_json::from_str::<String>(&view_response[0].to_string()).unwrap();

        Ok(convert_addr_string_to_h256(&ism_address).unwrap())
    }

    #[instrument(err, ret, skip(self))]
    async fn recipient_ism(&self, recipient: H256) -> ChainResult<H256> {
        // !TODO
        self.default_ism().await
    }

    #[instrument(err, ret, skip(self))]
    async fn process(
        &self,
        message: &HyperlaneMessage,
        metadata: &[u8],
        _tx_gas_limit: Option<U256>,
    ) -> ChainResult<TxOutcome> {
        // get recipient address
        let recipient: AccountAddress = message.recipient.0.into();

        let mut encoded_message = vec![];
        message.write_to(&mut encoded_message).unwrap();

        let payer = self
            .payer
            .as_ref()
            .ok_or_else(|| ChainCommunicationError::SignerUnavailable)?;

        // !TODO: modularize this
        let signer_priv_key =
            Ed25519PrivateKey::try_from(payer.secret().to_bytes().as_ref()).unwrap();
        let signer_address =
            AuthenticationKey::ed25519(&Ed25519PublicKey::from(&signer_priv_key)).derived_address();
        let mut signer_account = LocalAccount::new(
            signer_address,
            AccountKey::from_private_key(signer_priv_key),
            self.aptos_client
                .get_account(signer_address)
                .await
                .map_err(ChainCommunicationError::from_other)?
                .into_inner()
                .sequence_number,
        );

        let payload = utils::make_aptos_payload(
            recipient,
            "hello_world",
            "handle_message",
            vec![],
            vec![
                bcs::to_bytes(&encoded_message).unwrap(),
                bcs::to_bytes(&metadata.to_vec()).unwrap(),
            ],
        );

        let response =
            send_aptos_transaction(&self.aptos_client, &mut signer_account, payload.clone())
                .await
                .map_err(|e| {
                    println!("tx error {}", e.to_string());
                    ChainCommunicationError::TransactionTimeout()
                })?;

        // fetch transaction information from the response
        let tx_hash = response.transaction_info().unwrap().hash.to_string();
        let has_success = response.success();

        Ok(TxOutcome {
            transaction_id: H512::from_str(&tx_hash).unwrap_or(H512::zero()),
            executed: has_success,
            // TODO use correct data upon integrating IGP support
            gas_price: U256::zero(),
            gas_used: U256::zero(),
        })
    }

    #[instrument(err, ret, skip(self))]
    async fn process_estimate_costs(
        &self,
        _message: &HyperlaneMessage,
        _metadata: &[u8],
    ) -> ChainResult<TxCostEstimate> {
        // TODO use correct data upon integrating IGP support
        Ok(TxCostEstimate {
            gas_limit: U256::zero(),
            gas_price: U256::zero(),
            l2_gas_limit: None,
        })
    }

    fn process_calldata(&self, _message: &HyperlaneMessage, _metadata: &[u8]) -> Vec<u8> {
        todo!()
    }
}

/// Struct that retrieves event data for a Aptos Mailbox contract
#[derive(Debug)]
pub struct AptosMailboxIndexer {
    mailbox: AptosMailbox,
    aptos_client: AptosClient,
    package_address: AccountAddress,
}

impl AptosMailboxIndexer {
    pub fn new(conf: &ConnectionConf, locator: ContractLocator) -> ChainResult<Self> {
        let aptos_client = AptosClient::new(conf.url.to_string());
        let package_address =
            AccountAddress::from_bytes(<[u8; 32]>::from(locator.address)).unwrap();
        let mailbox = AptosMailbox::new(conf, locator, None)?;

        Ok(Self {
            mailbox,
            aptos_client,
            package_address,
        })
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        let chain_state = self
            .aptos_client
            .get_ledger_information()
            .await
            .map_err(ChainCommunicationError::from_other)
            .unwrap()
            .into_inner();
        Ok(chain_state.block_height as u32)
    }
}

#[async_trait]
impl MessageIndexer for AptosMailboxIndexer {
    #[instrument(err, skip(self))]
    async fn fetch_count_at_tip(&self) -> ChainResult<(u32, u32)> {
        let tip = Indexer::<HyperlaneMessage>::get_finalized_block_number(self as _).await?;
        // TODO: need to make sure the call and tip are at the same height?
        let count = self.mailbox.count(None).await?;
        Ok((count, tip))
    }
}

#[async_trait]
impl Indexer<HyperlaneMessage> for AptosMailboxIndexer {
    async fn fetch_logs(&self, range: IndexRange) -> ChainResult<Vec<(HyperlaneMessage, LogMeta)>> {
        info!("range type :{:?}", range);

        let BlockRange(range) = range else {
            return Err(ChainCommunicationError::from_other_str(
                "AptosMailboxIndexer only supports block-based indexing",
            ))
        };

        info!(?range, "Fetching AptosMailboxIndexer HyperlaneMessage logs");

        let dispatch_events = self
            .aptos_client
            .get_account_events(
                self.package_address,
                &format!(
                    "{}::mailbox::MailBoxState",
                    self.package_address.to_hex_literal()
                ),
                "dispatch_events",
                None,
                Some(10000),
            )
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

        let blk_start_no: u32 = *range.start();
        let blk_end_no = *range.end();
        let start_block = self
            .aptos_client
            .get_block_by_height(blk_start_no as u64, false)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        let end_block = self
            .aptos_client
            .get_block_by_height(blk_end_no as u64, false)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

        let start_tx_version = start_block.first_version;
        let end_tx_version = end_block.last_version;

        let new_dispatches: Vec<VersionedEvent> = dispatch_events
            .into_iter()
            .filter(|e| e.version.0 > start_tx_version.0 && e.version.0 <= end_tx_version.0)
            .collect();

        let mut messages = Vec::with_capacity((range.end() - range.start()) as usize);
        for dispatch in new_dispatches {
            let mut evt_data: DispatchEventData = dispatch.clone().try_into()?;
            messages.push((
                evt_data.into_hyperlane_msg()?,
                LogMeta {
                    address: self.mailbox.package_address.into_bytes().into(),
                    block_number: evt_data.block_height.parse().unwrap_or(0),
                    // TODO: get these when building out scraper support.
                    // It's inconvenient to get these :|
                    block_hash: H256::zero(),
                    transaction_id: H512::from_str(&evt_data.transaction_hash)
                        .unwrap_or(H512::zero()),
                    transaction_index: *dispatch.version.inner(),
                    log_index: U256::zero(),
                },
            ));
        }
        Ok(messages)
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_finalized_block_number().await
    }
}

#[async_trait]
impl Indexer<H256> for AptosMailboxIndexer {
    async fn fetch_logs(&self, _range: IndexRange) -> ChainResult<Vec<(H256, LogMeta)>> {
        todo!()
    }

    async fn get_finalized_block_number(&self) -> ChainResult<u32> {
        self.get_finalized_block_number().await
    }
}

struct AptosMailboxAbi;

// TODO figure out how this is used and if we can support it for Aptos.
impl HyperlaneAbi for AptosMailboxAbi {
    const SELECTOR_SIZE_BYTES: usize = 8;

    fn fn_map() -> HashMap<Vec<u8>, &'static str> {
        todo!()
    }
}
