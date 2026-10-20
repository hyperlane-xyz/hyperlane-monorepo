use std::{sync::Arc, time::Duration};

use ethers::{
    abi::{Function, Token},
    types::{transaction::eip2718::TypedTransaction, NameOrAddress, H160},
};
use eyre::{ensure, eyre, Result};
use hyperlane_core::{matching_list::MatchingList, Decode, HyperlaneMessage};
use hyperlane_ethereum::EvmProviderForLander;
use tracing::info;

use crate::{payload::FullPayload, transaction::Transaction, LanderError};

use super::EthereumAdapter;

pub(super) const RPC_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) async fn with_rpc_timeout<F: std::future::Future>(
    request: F,
) -> Result<F::Output, LanderError> {
    tokio::time::timeout(RPC_TIMEOUT, request)
        .await
        .map_err(|_| LanderError::TxSubmissionDeferred)
}

pub(crate) struct MevSubmission {
    pub mailbox: H160,
    pub matching_list: MatchingList,
    pub provider: Arc<dyn EvmProviderForLander>,
}

impl MevSubmission {
    pub(super) fn matches(&self, payload: &FullPayload) -> Result<bool> {
        let (tx, function): (TypedTransaction, Function) = serde_json::from_slice(&payload.data)?;
        if tx.to() != Some(&NameOrAddress::Address(self.mailbox)) {
            return Ok(false);
        }
        let data = tx
            .data()
            .ok_or_else(|| eyre!("Mailbox payload has no calldata"))?;
        ensure!(
            function.name == "process" && data.starts_with(&function.short_signature()),
            "Expected Mailbox.process payload for MEV classification"
        );
        let args = function.decode_input(
            data.get(4..)
                .ok_or_else(|| eyre!("Missing function arguments"))?,
        )?;
        let [Token::Bytes(_), Token::Bytes(message)] = args.as_slice() else {
            return Err(eyre!("Invalid Mailbox.process arguments"));
        };
        let message = HyperlaneMessage::read_from(&mut message.as_slice())?;
        Ok(self.matching_list.msg_matches(&message, false))
    }
}

impl EthereumAdapter {
    pub(super) async fn submission_provider(
        &self,
        tx: &Transaction,
    ) -> Result<&Arc<dyn EvmProviderForLander>, LanderError> {
        if self.mev_submission.is_none() {
            return Ok(&self.provider);
        }
        self.provider_for_payloads(&self.load_payloads(tx).await?)
    }

    pub(super) fn is_protected_provider(&self, provider: &Arc<dyn EvmProviderForLander>) -> bool {
        self.mev_submission
            .as_ref()
            .is_some_and(|mev| Arc::ptr_eq(provider, &mev.provider))
    }

    pub(super) fn provider_for_payloads(
        &self,
        payloads: &[FullPayload],
    ) -> Result<&Arc<dyn EvmProviderForLander>, LanderError> {
        let Some(mev) = &self.mev_submission else {
            return Ok(&self.provider);
        };
        // Inspect original payloads, not the Multicall wrapper. This also applies
        // after batch rebuilding, gas escalation, and recovery from the database.
        for payload in payloads {
            if mev.matches(payload)? {
                info!("Using MEV-protected RPCs");
                return Ok(&mev.provider);
            }
        }
        Ok(&self.provider)
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use ethers::{abi::AbiParser, types::TransactionRequest};
    use hyperlane_core::{ChainCommunicationError, Encode, H256};

    use crate::{
        adapter::{
            chains::ethereum::{
                tests::{dummy_evm_tx, ExpectedTxType, MockEvmProvider},
                transaction::Precursor,
            },
            AdaptsChain,
        },
        tests::{
            evm::test_utils::{
                mock_default_fee_history, mock_ethereum_adapter, mock_finalized_block_number,
                mock_get_block, mock_get_next_nonce_on_finalized_block,
            },
            test_utils::tmp_dbs,
        },
        TransactionStatus,
    };

    use super::*;

    const MAILBOX: H160 = H160([1; 20]);
    const ROUTER: H256 = H256([2; 32]);

    fn rules() -> MatchingList {
        serde_json::from_value(serde_json::json!([{
            "senderaddress": format!("{ROUTER:#x}"),
            "recipientaddress": format!("{ROUTER:#x}"),
            "bodyregex": "^02.{128}$",
        }]))
        .unwrap()
    }

    fn payload(message_type: u8, router: H256, mailbox: H160) -> FullPayload {
        let message = HyperlaneMessage {
            sender: router,
            recipient: router,
            body: [vec![message_type], vec![0; 64]].concat(),
            ..Default::default()
        };
        let function = AbiParser::default()
            .parse_function("process(bytes,bytes)")
            .unwrap();
        let mut message_bytes = Vec::new();
        message.write_to(&mut message_bytes).unwrap();
        let data = function
            .encode_input(&[Token::Bytes(vec![]), Token::Bytes(message_bytes)])
            .unwrap();
        let tx: TypedTransaction = TransactionRequest::new().to(mailbox).data(data).into();
        let mut payload = FullPayload::random();
        payload.data = serde_json::to_vec(&(tx, function)).unwrap();
        payload
    }

    fn adapter(
        normal_sends: usize,
        protected_sends: usize,
        fail_protected: bool,
    ) -> EthereumAdapter {
        let (payload_db, tx_db, nonce_db) = tmp_dbs();
        let mut normal = MockEvmProvider::new();
        mock_finalized_block_number(&mut normal);
        mock_get_block(&mut normal);
        mock_get_next_nonce_on_finalized_block(&mut normal);
        mock_default_fee_history(&mut normal);
        normal
            .expect_send()
            .times(normal_sends)
            .returning(|_, _| Ok(H256::zero()));
        let mut protected = MockEvmProvider::new();
        protected
            .expect_send()
            .times(protected_sends)
            .returning(move |_, _| {
                if fail_protected {
                    Err(ChainCommunicationError::CustomError(
                        "protected endpoint unavailable".into(),
                    ))
                } else {
                    Ok(H256::zero())
                }
            });
        let mut adapter = mock_ethereum_adapter(
            normal,
            payload_db,
            tx_db,
            nonce_db,
            H160::zero(),
            Duration::from_secs(1),
            Duration::ZERO,
        );
        adapter.mev_submission = Some(MevSubmission {
            mailbox: MAILBOX,
            matching_list: rules(),
            provider: Arc::new(protected),
        });
        adapter
    }

    async fn transaction(adapter: &EthereumAdapter, payloads: Vec<FullPayload>) -> Transaction {
        for payload in &payloads {
            adapter
                .payload_db
                .store_payload_by_uuid(payload)
                .await
                .unwrap();
        }
        dummy_evm_tx(
            ExpectedTxType::Eip1559,
            payloads,
            TransactionStatus::PendingInclusion,
            adapter.signer,
        )
    }

    #[tokio::test]
    async fn reveal_and_replacement_never_use_normal_provider() {
        let adapter = adapter(0, 2, false);
        let mut tx = transaction(&adapter, vec![payload(2, ROUTER, MAILBOX)]).await;
        adapter.submit(&mut tx).await.unwrap();
        let nonce = tx.precursor().tx.nonce().copied();
        // Deserialize as recovery does, then submit a replacement using stored payloads.
        let mut recovered: Transaction =
            serde_json::from_slice(&serde_json::to_vec(&tx).unwrap()).unwrap();
        adapter.submit(&mut recovered).await.unwrap();
        assert_eq!(recovered.precursor().tx.nonce().copied(), nonce);
    }

    #[tokio::test]
    async fn live_ethereum_to_arbitrum_ica_reveal_uses_protected_provider() {
        // Authentic ICA Dispatch envelope, Ethereum block 26185203, nonce 296883.
        // https://etherscan.io/block/26185203 (not attributed to the Aero MetaRouter).
        let message = ethers::utils::hex::decode(concat!(
            "03000487b300000001000000000000000000000000c00b94c115742f711a6f9ea90373c33e9b72a4a9",
            "0000a4b1000000000000000000000000f90a3d406c6f8321fe118861a357f4d7107760d7",
            "0200000000000000000000000000000000000000000000000000000000000000001c14b4c9f8dada31b01ccc6bc312277317371542f985b5832ee3d4f2a09faea5",
        ))
        .unwrap();
        let mailbox: H160 = "0x979ca5202784112f4738403dbec5d0f3b9daabb9"
            .parse()
            .unwrap();
        let mut adapter = adapter(0, 1, false);
        let mev = adapter.mev_submission.as_mut().unwrap();
        mev.mailbox = mailbox;
        mev.matching_list = serde_json::from_value(serde_json::json!([{
            "origindomain": 1,
            "senderaddress": "0xc00b94c115742f711a6f9ea90373c33e9b72a4a9",
            "destinationdomain": 42161,
            "recipientaddress": "0xf90a3d406c6f8321fe118861a357f4d7107760d7",
            "bodyregex": "^02.{64}",
        }]))
        .unwrap();
        let function = AbiParser::default()
            .parse_function("process(bytes,bytes)")
            .unwrap();
        let data = function
            .encode_input(&[Token::Bytes(vec![]), Token::Bytes(message)])
            .unwrap();
        let request: TypedTransaction = TransactionRequest::new().to(mailbox).data(data).into();
        let mut payload = FullPayload::random();
        payload.data = serde_json::to_vec(&(request, function)).unwrap();
        let mut tx = transaction(&adapter, vec![payload]).await;
        adapter.submit(&mut tx).await.unwrap();
    }

    #[tokio::test]
    async fn mixed_batch_is_submitted_entirely_through_protected_provider() {
        let adapter = adapter(0, 1, false);
        let mut tx = transaction(
            &adapter,
            vec![payload(1, ROUTER, MAILBOX), payload(2, ROUTER, MAILBOX)],
        )
        .await;
        adapter.submit(&mut tx).await.unwrap();
    }

    #[tokio::test]
    async fn commits_and_unrelated_messages_use_normal_provider() {
        let adapter = adapter(1, 0, false);
        let mut tx = transaction(
            &adapter,
            vec![
                payload(1, ROUTER, MAILBOX),
                payload(0, ROUTER, MAILBOX),
                payload(2, H256::zero(), MAILBOX),
                payload(2, ROUTER, H160::zero()),
            ],
        )
        .await;
        adapter.submit(&mut tx).await.unwrap();
    }

    #[tokio::test]
    async fn unconfigured_destination_uses_normal_provider() {
        let mut adapter = adapter(1, 0, false);
        adapter.mev_submission = None;
        let mut tx = transaction(&adapter, vec![payload(2, ROUTER, MAILBOX)]).await;
        adapter.submit(&mut tx).await.unwrap();
    }

    #[tokio::test]
    async fn protected_failure_retries_without_public_fallback() {
        let adapter = adapter(0, 2, true);
        let mut tx = transaction(&adapter, vec![payload(2, ROUTER, MAILBOX)]).await;
        assert!(adapter.submit(&mut tx).await.is_err());
        assert!(tx.precursor().tx.nonce().is_none());
        assert!(adapter.submit(&mut tx).await.is_err());
    }

    #[tokio::test]
    async fn missing_or_malformed_payload_blocks_submission_before_nonce_assignment() {
        let adapter = adapter(0, 0, false);
        let mut tx = dummy_evm_tx(
            ExpectedTxType::Eip1559,
            vec![FullPayload::random()],
            TransactionStatus::PendingInclusion,
            adapter.signer,
        );
        assert!(matches!(
            adapter.submit(&mut tx).await,
            Err(LanderError::PayloadNotFound)
        ));
        assert!(tx.precursor().tx.nonce().is_none());
        let mut tx = transaction(&adapter, vec![FullPayload::random()]).await;
        assert!(adapter.submit(&mut tx).await.is_err());
        assert!(tx.precursor().tx.nonce().is_none());
    }
    #[tokio::test(start_paused = true)]
    async fn protected_rpc_timeout_is_bounded() {
        let started = tokio::time::Instant::now();
        assert!(matches!(
            with_rpc_timeout(std::future::pending::<()>()).await,
            Err(LanderError::TxSubmissionDeferred)
        ));
        assert_eq!(started.elapsed(), RPC_TIMEOUT);
    }

    #[tokio::test]
    async fn protected_reveals_are_built_separately_from_ordinary_payloads() {
        let adapter = adapter(0, 0, false);
        let commit = payload(1, ROUTER, MAILBOX);
        let reveal = payload(2, ROUTER, MAILBOX);
        let results = adapter
            .build_transactions(&[commit.clone(), reveal.clone()])
            .await;
        assert_eq!(results.len(), 2);
        assert!(results
            .iter()
            .all(|r| r.maybe_tx.is_some() && r.payloads.len() == 1));
        assert!(results
            .iter()
            .any(|r| r.payloads[0].uuid == reveal.details.uuid));
        assert!(results
            .iter()
            .any(|r| r.payloads[0].uuid == commit.details.uuid));
    }

    #[tokio::test]
    async fn protected_preflights_cover_single_and_recovered_mixed_transactions() {
        let mut adapter = adapter(0, 0, false);
        let mut protected = MockEvmProvider::new();
        mock_get_block(&mut protected);
        protected
            .expect_estimate_gas_limit()
            .times(3)
            .returning(|_, _| Ok(100_000.into()));
        protected
            .expect_simulate_batch()
            .times(1)
            .returning(|_| Ok((vec![0, 1], vec![])));
        protected
            .expect_batch()
            .times(1)
            .returning(|_, _, precursors, _| Ok(precursors[0].clone()));
        protected
            .expect_estimate_batch()
            .times(1)
            .returning(|_, _| Ok(300_000.into()));
        adapter.mev_submission.as_mut().unwrap().provider = Arc::new(protected);

        let reveal = payload(2, ROUTER, MAILBOX);
        let mut single = transaction(&adapter, vec![reveal.clone()]).await;
        adapter.estimate_tx(&mut single).await.unwrap();
        assert!(single.precursor().tx.gas().is_some());

        // Old database entries may contain mixed batches; every preflight stays private.
        let mut recovered = transaction(&adapter, vec![payload(1, ROUTER, MAILBOX), reveal]).await;
        assert!(adapter
            .simulate_tx(&mut recovered)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(recovered.payload_details.len(), 2);
        adapter.estimate_tx(&mut recovered).await.unwrap();
        assert_eq!(
            recovered.precursor().tx.gas().copied(),
            Some(300_000.into())
        );
    }
    #[derive(Debug)]
    struct StalledRpc;

    #[async_trait::async_trait]
    impl ethers::providers::JsonRpcClient for StalledRpc {
        type Error = ethers::providers::ProviderError;

        async fn request<T, R>(&self, _method: &str, _params: T) -> Result<R, Self::Error>
        where
            T: std::fmt::Debug + serde::Serialize + Send + Sync,
            R: serde::de::DeserializeOwned,
        {
            std::future::pending().await
        }
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_protected_send_keeps_nonce_for_retry() {
        let mut adapter = adapter(0, 0, false);
        adapter.mev_submission.as_mut().unwrap().provider =
            Arc::new(hyperlane_ethereum::EthereumProvider::new(
                Arc::new(ethers::providers::Provider::new(StalledRpc)),
                adapter.domain.clone(),
            ));
        let mut tx = transaction(&adapter, vec![payload(2, ROUTER, MAILBOX)]).await;
        assert!(matches!(
            adapter.submit(&mut tx).await,
            Err(LanderError::TxSubmissionDeferred)
        ));
        let assigned_nonce = tx.precursor().tx.nonce().copied();
        assert!(assigned_nonce.is_some());
        let mut recovered = MockEvmProvider::new();
        recovered
            .expect_send()
            .times(1)
            .returning(|_, _| Ok(H256::zero()));
        adapter.mev_submission.as_mut().unwrap().provider = Arc::new(recovered);
        adapter.submit(&mut tx).await.unwrap();
        assert_eq!(tx.precursor().tx.nonce().copied(), assigned_nonce);
    }
    #[tokio::test]
    async fn failed_protected_replacement_keeps_previous_hash_and_nonce() {
        let mut adapter = adapter(0, 1, false);
        let mut tx = transaction(&adapter, vec![payload(2, ROUTER, MAILBOX)]).await;
        adapter.submit(&mut tx).await.unwrap();
        let nonce = tx.precursor().tx.nonce().copied();
        let hashes = tx.tx_hashes.clone();
        let mut unavailable = MockEvmProvider::new();
        unavailable.expect_send().times(1).returning(|_, _| {
            Err(ChainCommunicationError::CustomError(
                "relay unavailable".into(),
            ))
        });
        adapter.mev_submission.as_mut().unwrap().provider = Arc::new(unavailable);
        // Force different signed bytes, rather than rebroadcasting the original price.
        adapter.transaction_overrides.gas_price = Some(1_000.into());
        assert!(matches!(
            adapter.submit(&mut tx).await,
            Err(LanderError::TxGasCapReached)
        ));
        assert_eq!(tx.precursor().tx.gas_price(), Some(1_000.into()));
        assert_eq!(tx.precursor().tx.nonce().copied(), nonce);
        assert_eq!(tx.tx_hashes, hashes);
    }
}
