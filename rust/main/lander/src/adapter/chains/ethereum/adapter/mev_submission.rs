use std::{sync::Arc, time::Duration};

use ethers::{
    abi::{Function, Token},
    types::{transaction::eip2718::TypedTransaction, NameOrAddress, H160},
};
use eyre::{ensure, eyre, Result};
use hyperlane_core::{Decode, HyperlaneMessage};
use hyperlane_ethereum::{EvmProviderForLander, MevSubmissionConfig};
use tracing::{info, warn};

use crate::{payload::FullPayload, transaction::Transaction, LanderError};

use super::EthereumAdapter;

pub(super) const RPC_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) async fn with_rpc_timeout<F: std::future::Future>(
    protected: bool,
    request: F,
) -> Result<F::Output, LanderError> {
    if !protected {
        return Ok(request.await);
    }
    tokio::time::timeout(RPC_TIMEOUT, request)
        .await
        .map_err(|_| LanderError::TxSubmissionDeferred)
}

pub(super) async fn preflight<T, E: Into<LanderError>>(
    protected: bool,
    request: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, LanderError> {
    with_rpc_timeout(protected, request).await?.map_err(|err| {
        let err = err.into();
        if protected {
            warn!(?err, "Protected preflight failed; retrying later");
            LanderError::TxSubmissionDeferred
        } else {
            err
        }
    })
}

pub(crate) struct MevSubmission {
    pub mailbox: H160,
    pub policy: MevSubmissionConfig,
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
        Ok(self.policy.matches(&message))
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

    use ethers::{
        abi::AbiParser,
        signers::{LocalWallet, Signer},
        types::TransactionRequest,
    };
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

    fn wallet() -> LocalWallet {
        LocalWallet::from(ethers::core::k256::SecretKey::from_be_bytes(&[1; 32]).unwrap())
            .with_chain_id(1_u64)
    }

    fn payload(message_type: u8, router: H256, mailbox: H160) -> FullPayload {
        let message = HyperlaneMessage {
            sender: router,
            recipient: router,
            body: [vec![message_type], vec![0; 64]].concat(),
            ..Default::default()
        };
        let mut bytes = Vec::new();
        message.write_to(&mut bytes).unwrap();
        envelope_payload(bytes, mailbox)
    }

    fn envelope_payload(bytes: Vec<u8>, mailbox: H160) -> FullPayload {
        let function = AbiParser::default()
            .parse_function("process(bytes,bytes)")
            .unwrap();
        let data = function
            .encode_input(&[Token::Bytes(vec![]), Token::Bytes(bytes)])
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
            .expect_batch()
            .returning(|_, _, precursors, _| Ok(precursors[0].clone()));
        normal
            .expect_send()
            .times(normal_sends)
            .returning(|_, _| Ok(H256::zero()));
        let mut protected = MockEvmProvider::new();
        protected
            .expect_sign_transaction()
            .times(protected_sends)
            .returning(|tx| Ok(serde_json::to_vec(tx).unwrap().into()));
        protected
            .expect_send_raw_transaction()
            .times(protected_sends)
            .returning(move |bytes| {
                if fail_protected {
                    Err(ChainCommunicationError::CustomError(
                        "protected endpoint unavailable".into(),
                    ))
                } else {
                    Ok(ethers::utils::keccak256(bytes).into())
                }
            });
        let mut adapter = mock_ethereum_adapter(
            normal,
            payload_db,
            tx_db,
            nonce_db,
            wallet().address(),
            Duration::from_secs(1),
            Duration::ZERO,
        );
        adapter.mev_submission = Some(MevSubmission {
            mailbox: MAILBOX,
            policy: MevSubmissionConfig {
                rpc_urls: vec![],
                ica_router: ROUTER,
            },
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
        let mut adapter = adapter(0, 2, false);
        let mut tx = transaction(&adapter, vec![payload(2, ROUTER, MAILBOX)]).await;
        adapter.submit(&mut tx).await.unwrap();
        let nonce = tx.precursor().tx.nonce().copied();
        // Deserialize as recovery does, then submit a replacement using stored payloads.
        let mut recovered: Transaction =
            serde_json::from_slice(&serde_json::to_vec(&tx).unwrap()).unwrap();
        adapter.submit(&mut recovered).await.unwrap();
        assert_eq!(recovered.precursor().tx.nonce().copied(), nonce);
        let hashes = recovered.tx_hashes.clone();
        let mut unavailable = MockEvmProvider::new();
        unavailable
            .expect_sign_transaction()
            .times(1)
            .returning(|tx| Ok(serde_json::to_vec(tx).unwrap().into()));
        unavailable
            .expect_send_raw_transaction()
            .times(1)
            .returning(|_| {
                Err(ChainCommunicationError::CustomError(
                    "relay unavailable".into(),
                ))
            });
        adapter.mev_submission.as_mut().unwrap().provider = Arc::new(unavailable);
        // Force different signed bytes, rather than rebroadcasting the original price.
        adapter.transaction_overrides.gas_price = Some(1_000.into());
        assert!(matches!(
            adapter.submit(&mut recovered).await,
            Err(LanderError::TxSubmissionDeferred)
        ));
        assert_eq!(recovered.precursor().tx.gas_price(), Some(1_000.into()));
        assert_eq!(recovered.precursor().tx.nonce().copied(), nonce);
        assert!(recovered.tx_hashes.starts_with(&hashes));
        assert_eq!(recovered.tx_hashes.len(), hashes.len() + 1);
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
        mev.policy.ica_router = "0xf90a3d406c6f8321fe118861a357f4d7107760d7"
            .parse::<H160>()
            .unwrap()
            .into();
        let mut tx = transaction(&adapter, vec![envelope_payload(message, mailbox)]).await;
        adapter.submit(&mut tx).await.unwrap();
    }

    #[tokio::test]
    async fn routes_reveals_and_mixed_batches_but_not_commits_or_unrelated_messages() {
        for (enabled, payloads, private) in [
            (true, vec![payload(2, ROUTER, MAILBOX)], true),
            (
                true,
                vec![payload(1, ROUTER, MAILBOX), payload(2, ROUTER, MAILBOX)],
                true,
            ),
            (
                true,
                vec![
                    payload(1, ROUTER, MAILBOX),
                    payload(0, ROUTER, MAILBOX),
                    payload(2, H256::zero(), MAILBOX),
                    payload(2, ROUTER, H160::zero()),
                ],
                false,
            ),
            (false, vec![payload(2, ROUTER, MAILBOX)], false),
        ] {
            let mut adapter = adapter(usize::from(!private), usize::from(private), false);
            if !enabled {
                adapter.mev_submission = None;
            }
            let mut tx = transaction(&adapter, payloads).await;
            adapter.submit(&mut tx).await.unwrap();
        }
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
    async fn fast_preflight_errors_defer_only_protected_transactions() {
        for protected in [true, false] {
            let mut adapter = adapter(0, 0, false);
            let mut provider = MockEvmProvider::new();
            provider
                .expect_estimate_gas_limit()
                .times(2)
                .returning(|_, _| {
                    Err(ChainCommunicationError::CustomError(
                        "RPC unavailable".into(),
                    ))
                });
            provider.expect_simulate_batch().times(1).returning(|_| {
                Err(ChainCommunicationError::CustomError(
                    "RPC unavailable".into(),
                ))
            });
            if protected {
                adapter.mev_submission.as_mut().unwrap().provider = Arc::new(provider);
            } else {
                adapter.mev_submission = None;
                adapter.provider = Arc::new(provider);
            }
            let mut single = transaction(&adapter, vec![payload(2, ROUTER, MAILBOX)]).await;
            let mut mixed = transaction(
                &adapter,
                vec![payload(1, ROUTER, MAILBOX), payload(2, ROUTER, MAILBOX)],
            )
            .await;
            let original = mixed.clone();
            let results = [
                adapter.simulate_tx(&mut mixed).await.map(|_| ()),
                adapter.estimate_tx(&mut single).await,
                adapter.estimate_tx(&mut mixed).await,
            ];
            for result in results {
                if protected {
                    assert!(matches!(result, Err(LanderError::TxSubmissionDeferred)));
                } else {
                    assert!(matches!(
                        result,
                        Err(LanderError::ChainCommunicationError(_))
                    ));
                }
            }
            assert_eq!(mixed, original);
        }
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
    #[tokio::test]
    async fn protected_preflights_cover_single_and_recovered_mixed_transactions() {
        let mut adapter = adapter(0, 0, false);
        let mut protected = MockEvmProvider::new();
        mock_get_block(&mut protected);
        protected
            .expect_estimate_gas_limit()
            .times(5)
            .returning(|_, _| Ok(100_000.into()));
        protected
            .expect_simulate_batch()
            .times(1)
            .returning(|_| Ok((vec![0, 1], vec![])));
        let mut estimates = mockall::Sequence::new();
        protected
            .expect_estimate_batch()
            .times(1)
            .in_sequence(&mut estimates)
            .returning(|_, _| {
                Err(ChainCommunicationError::CustomError(
                    "RPC unavailable".into(),
                ))
            });
        protected
            .expect_estimate_batch()
            .times(1)
            .in_sequence(&mut estimates)
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
        assert!(matches!(
            adapter.estimate_tx(&mut recovered).await,
            Err(LanderError::TxSubmissionDeferred)
        ));
        assert_eq!(recovered.payload_details.len(), 2);
        assert!(recovered.precursor().tx.gas().is_none());
        adapter.estimate_tx(&mut recovered).await.unwrap();
        assert_eq!(
            recovered.precursor().tx.gas().copied(),
            Some(300_000.into())
        );
    }
    #[derive(Debug)]
    struct StalledRpc(Arc<std::sync::Mutex<Option<ethers::types::Bytes>>>);

    #[async_trait::async_trait]
    impl ethers::providers::JsonRpcClient for StalledRpc {
        type Error = ethers::providers::ProviderError;

        async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
        where
            T: std::fmt::Debug + serde::Serialize + Send + Sync,
            R: serde::de::DeserializeOwned,
        {
            assert_eq!(method, "eth_sendRawTransaction");
            let bytes: Vec<ethers::types::Bytes> =
                serde_json::from_value(serde_json::to_value(params).unwrap()).unwrap();
            *self.0.lock().unwrap() = Some(bytes[0].clone());
            std::future::pending().await
        }
    }

    #[tokio::test(start_paused = true)]
    async fn accepted_protected_send_with_lost_response_is_detected_after_recovery() {
        use ethers::{middleware::SignerMiddleware, providers::Provider};
        let accepted_bytes = Arc::new(std::sync::Mutex::new(None));
        let mut adapter = adapter(0, 0, false);
        adapter.mev_submission.as_mut().unwrap().provider =
            Arc::new(hyperlane_ethereum::EthereumProvider::new(
                Arc::new(SignerMiddleware::new(
                    Provider::new(StalledRpc(accepted_bytes.clone())),
                    wallet(),
                )),
                adapter.domain.clone(),
            ));
        let mut tx = transaction(&adapter, vec![payload(2, ROUTER, MAILBOX)]).await;
        tx.precursor_mut().tx.set_gas(100_000_u64);
        let started = tokio::time::Instant::now();
        let result = adapter.submit(&mut tx).await;
        assert!(
            matches!(result, Err(LanderError::TxSubmissionDeferred)),
            "{result:?}"
        );
        assert_eq!(started.elapsed(), RPC_TIMEOUT);
        let assigned_nonce = tx.precursor().tx.nonce().copied();
        assert!(assigned_nonce.is_some());
        let hash = H256::from(ethers::utils::keccak256(
            accepted_bytes.lock().unwrap().as_ref().unwrap(),
        ));
        assert_eq!(tx.tx_hashes, vec![hash.into()]);
        // Retention persists these fields. Recover as the inclusion stage does,
        // then observe the accepted send finalizing instead of resubmitting it.
        let recovered: Transaction =
            serde_json::from_slice(&serde_json::to_vec(&tx).unwrap()).unwrap();
        let mut normal = MockEvmProvider::new();
        normal
            .expect_get_transaction_receipt()
            .times(1)
            .withf(move |h| *h == hash)
            .returning(|_| {
                Ok(Some(ethers::types::TransactionReceipt {
                    block_number: Some(10.into()),
                    ..Default::default()
                }))
            });
        normal
            .expect_get_finalized_block_number()
            .times(1)
            .returning(|_| Ok(10));
        adapter.provider = Arc::new(normal);
        let statuses = adapter.tx_statuses(&[recovered]).await;
        assert!(matches!(
            statuses.as_slice(),
            [Ok(TransactionStatus::Finalized)]
        ));
    }
}
