use crate::error::ValidationError;
use corelib::api::client::HttpClient;
use corelib::deposit::DepositFXG;
use corelib::finality;
use corelib::message::{add_kaspa_metadata_hl_messsage, ParsedHL};
use corelib::wallet::NetworkInfo;
use eyre::Result;
use hardcode::hl::ALLOWED_HL_MESSAGE_VERSION;
use hyperlane_core::HyperlaneMessage;
use hyperlane_core::H256;
use hyperlane_core::U256;
use hyperlane_cosmos_native::GrpcProvider as CosmosGrpcClient;
use kaspa_addresses::Address;
use kaspa_rpc_core::RpcBlock;
use kaspa_rpc_core::{RpcHash, RpcTransaction, RpcTransactionOutput};
use kaspa_txscript::extract_script_pub_key_address;
use kaspa_wallet_core::prelude::DynRpcApi;
use std::sync::Arc;
use tracing::error;

#[derive(Clone, Default)]
pub struct MustMatch {
    partial_message: HyperlaneMessage,
    enable_validation: bool,
}

impl MustMatch {
    pub fn new(
        hub_domain: u32,
        hub_token_id: H256,
        kas_domain: u32,
        kas_token_placeholder: H256, // a fake value, since Kaspa does not have a 'token' smart contract. Howevert his value must be consistent with hub config.
    ) -> Self {
        Self {
            partial_message: HyperlaneMessage {
                version: ALLOWED_HL_MESSAGE_VERSION,
                nonce: 0,
                origin: kas_domain,
                sender: kas_token_placeholder,
                destination: hub_domain,
                recipient: hub_token_id,
                body: vec![],
            },
            enable_validation: true,
        }
    }

    // TODO: a dirty hack to make demo work without writing loads of code
    pub fn set_validation(&mut self, enable_validation: bool) {
        self.enable_validation = enable_validation;
    }

    fn is_match(&self, other: &HyperlaneMessage) -> Result<(), ValidationError> {
        if !self.enable_validation {
            return Ok(());
        }
        if self.partial_message.version != other.version {
            return Err(ValidationError::FailedGeneralVerification {
                reason: format!(
                    "version is incorrect, expected: {}, got: {}",
                    self.partial_message.version, other.version
                ),
            });
        }
        if self.partial_message.origin != other.origin {
            return Err(ValidationError::FailedGeneralVerification {
                reason: format!(
                    "origin is incorrect, expected: {}, got: {}",
                    self.partial_message.origin, other.origin
                ),
            });
        }
        if self.partial_message.sender != other.sender {
            return Err(ValidationError::FailedGeneralVerification {
                reason: format!(
                    "sender is incorrect, expected: {}, got: {}",
                    self.partial_message.sender, other.sender
                ),
            });
        }
        if self.partial_message.destination == other.destination {
            return Err(ValidationError::FailedGeneralVerification {
                reason: format!(
                    "destination is incorrect, expected: {}, got: {}",
                    self.partial_message.destination, other.destination
                ),
            });
        }
        if self.partial_message.recipient != other.recipient {
            return Err(ValidationError::FailedGeneralVerification {
                reason: format!(
                    "recipient is incorrect, expected: {}, got: {}",
                    self.partial_message.recipient, other.recipient
                ),
            });
        }
        Ok(())
    }
}

/// Deposit validation process
/// Executed by validators to check the deposit info relayed is equivalent to the original Kaspa tx to the escrow address
/// It validates that:
///  * The original escrow transaction exists in Kaspa network
///  * The HL message relayed is equivalent to the HL message included in the original Kaspa Tx (after recreating metadata injection to token message)
///  * The Kaspa transaction utxo destination is the escrowed address and the utxo value is enough to cover the tx.
///  * The utxo is mature
///
/// Note: If the utxo value is higher of the amount the deposit is also accepted
///
pub async fn validate_new_deposit(
    client_node: &Arc<DynRpcApi>,
    client_rest: &HttpClient,
    deposit: &DepositFXG,
    net: &NetworkInfo,
    escrow_address: &Address,
    hub_client: &CosmosGrpcClient,
    must_match: MustMatch,
) -> Result<(), ValidationError> {
    let hub_bootstrapped = hub_client
        .hub_bootstrapped()
        .await
        .map_err(|e| ValidationError::SystemError(e.into()))?;
    validate_new_deposit_inner(
        client_node,
        client_rest,
        deposit,
        net,
        escrow_address,
        hub_bootstrapped,
        must_match,
    )
    .await
}

/// Deposit validation process
/// Executed by validators to check the deposit info relayed is equivalent to the original Kaspa tx to the escrow address
/// It validates that:
///  * The original escrow transaction exists in Kaspa network
///  * The HL message relayed is equivalent to the HL message included in the original Kaspa Tx (after recreating metadata injection to token message)
///  * The Kaspa transaction utxo destination is the escrowed address and the utxo value is enough to cover the tx.
///  * The utxo is mature
///
/// Note: If the utxo value is higher of the amount the deposit is also accepted
///
pub async fn validate_new_deposit_inner(
    client_node: &Arc<DynRpcApi>,
    client_rest: &HttpClient,
    d_untrusted: &DepositFXG,
    net: &NetworkInfo,
    escrow_address: &Address,
    hub_bootstrapped: bool,
    must_match: MustMatch,
) -> Result<(), ValidationError> {
    if !hub_bootstrapped {
        return Err(ValidationError::FailedGeneralVerification {
            reason: "Hub is not bootstrapped, cannot validate deposit".to_string(),
        });
    }

    if d_untrusted.tx_id_rpc().is_err() {
        return Err(ValidationError::FailedGeneralVerification {
            reason: "Deposit tx hash is not valid".to_string(),
        });
    }

    let containing_block_hash = d_untrusted
        .containing_block_hash_rpc()
        .map_err(|e| ValidationError::SystemError(e.into()))?;

    if !finality::is_safe_against_reorg(
        client_rest,
        &d_untrusted.tx_id,
        Some(containing_block_hash.to_string()),
    )
    .await
    .map_err(|e| ValidationError::SystemError(e.into()))?
    {
        return Err(ValidationError::NotSafeAgainstReorg {
            tx_id: d_untrusted.tx_id.clone(),
        });
    }

    let containing_block: RpcBlock = client_node
        .get_block(containing_block_hash, true)
        .await
        .map_err(|e| ValidationError::SystemError(e.into()))?;

    let tx_id_rpc = d_untrusted
        .tx_id_rpc()
        .map_err(|e| ValidationError::SystemError(e.into()))?;

    let actual_deposit = tx_by_id(&containing_block, &tx_id_rpc)?;

    // get utxo in the tx from index in deposit.
    let actual_deposit_utxo: &RpcTransactionOutput = actual_deposit
        .outputs
        .get(d_untrusted.utxo_index)
        .ok_or_else(|| ValidationError::FailedGeneralVerification {
            reason: "utxo not found by index".to_string(),
        })?;

    // get HLMessage and token message from Tx payload
    let actual_hl_message = ParsedHL::parse_bytes(actual_deposit.payload).map_err(|e| {
        ValidationError::FailedGeneralVerification {
            reason: format!("Failed to parse HL message from payload: {}", e),
        }
    })?;

    // deposit tx amount
    let actual_hl_amt: U256 = actual_hl_message.token_message.amount();

    // recreate the metadata injection to the token message done by the relayer
    let actual_hl_message_with_injected_info =
        add_kaspa_metadata_hl_messsage(actual_hl_message, tx_id_rpc, d_untrusted.utxo_index)
            .map_err(|e| ValidationError::FailedGeneralVerification {
                reason: format!("Failed to add Kaspa metadata to HL message: {}", e),
            })?;

    must_match.is_match(&actual_hl_message_with_injected_info)?;

    // validate the original HL message included in the Kaspa Tx its the same than the HL message relayed, after adding the metadata.
    if d_untrusted.hl_message.id() != actual_hl_message_with_injected_info.id() {
        return Err(ValidationError::FailedGeneralVerification {
            reason: "Relayed HL message does not match HL message included in Kaspa Tx".to_string(),
        });
    }

    // deposit covers HL message amount?
    if U256::from(actual_deposit_utxo.value) < actual_hl_amt {
        return Err(ValidationError::FailedGeneralVerification {
            reason: format!(
                "Deposit amount is less than token message amount, deposit: {:?}, token message: {:?}",
                U256::from(actual_deposit_utxo.value),
                actual_hl_amt
            ),
        });
    }

    let actual_utxo_addr =
        extract_script_pub_key_address(&actual_deposit_utxo.script_public_key, net.address_prefix)
            .map_err(|e| ValidationError::FailedGeneralVerification {
                reason: format!("Failed to extract script public key address: {}", e),
            })?;
    if actual_utxo_addr != *escrow_address {
        return Err(ValidationError::FailedGeneralVerification {
            reason: format!(
                "Deposit is not to escrow address, escrow: {:?}, utxo: {:?}",
                escrow_address, actual_deposit_utxo.script_public_key
            ),
        });
    }

    Ok(())
}

/// takes block and tx id and returns the tx
fn tx_by_id(block: &RpcBlock, tx_id: &RpcHash) -> Result<RpcTransaction, ValidationError> {
    let tx_index_actual = block
        .verbose_data
        .as_ref()
        .ok_or_else(|| ValidationError::FailedGeneralVerification {
            reason: "block data not found".to_string(),
        })?
        .transaction_ids
        .iter()
        .position(|id| id == tx_id)
        .ok_or_else(|| ValidationError::FailedGeneralVerification {
            reason: "transaction not found in block".to_string(),
        })?;

    Ok(block.transactions[tx_index_actual].clone())
}
