use crate::{
    contracts::{
        interchain_gas_paymaster::{GasPaymentEvent, InterchainGasPaymaster as FuelIgpContract},
        mailbox::{DispatchEvent, Mailbox as FuelMailboxContract},
        merkle_tree_hook::{InsertedIntoTreeEvent, MerkleTreeHook as FuelMerkleTreeHookContract},
    },
    conversions::*,
};
use fuels::{
    accounts::wallet::WalletUnlocked,
    core::{
        codec::LogDecoder,
        traits::{Parameterize, Tokenizable},
    },
    programs::calls::ContractDependency,
    types::bech32::Bech32ContractId,
};
use hyperlane_core::{HyperlaneMessage, Indexed, InterchainGasPayment, MerkleTreeInsertion, U256};
use std::fmt::Debug;

/// Trait combination for Events which are supported by the Fuel Indexer
pub trait FuelIndexerEvent:
    Tokenizable + Parameterize + HasLogDecoder + Clone + Debug + 'static + EventDataTransformer
{
}
impl<E> FuelIndexerEvent for E where
    E: Tokenizable + Parameterize + HasLogDecoder + Clone + Debug + 'static + EventDataTransformer
{
}

///////////////////////////////////////////////////
// Transformations for each supported event type //
///////////////////////////////////////////////////

impl From<GasPaymentEvent> for InterchainGasPayment {
    fn from(event: GasPaymentEvent) -> Self {
        InterchainGasPayment {
            message_id: event.message_id.into_h256(),
            gas_amount: U256::from(event.gas_amount),
            payment: U256::from(event.payment),
            destination: event.destination_domain,
        }
    }
}

impl From<DispatchEvent> for HyperlaneMessage {
    fn from(event: DispatchEvent) -> Self {
        HyperlaneMessage::from(event.message.bytes.0)
    }
}

impl From<InsertedIntoTreeEvent> for MerkleTreeInsertion {
    fn from(event: InsertedIntoTreeEvent) -> Self {
        MerkleTreeInsertion::new(event.index, event.message_id.into_h256())
    }
}

/// Trait to transform events into indexable data types.
pub trait EventDataTransformer {
    fn transform<T>(self) -> T
    where
        T: From<Self> + Into<Indexed<T>> + PartialEq + Send + Sync + Debug + 'static,
        Self: Sized;
}

// Implement `EventDataTransformer` for `GasPaymentEvent`
impl EventDataTransformer for GasPaymentEvent {
    fn transform<T>(self) -> T
    where
        T: From<Self> + Into<Indexed<T>> + PartialEq + Send + Sync + Debug + 'static,
    {
        T::from(self)
    }
}

// Implement `EventDataTransformer` for `DispatchEvent`
impl EventDataTransformer for DispatchEvent {
    fn transform<T>(self) -> T
    where
        T: From<Self> + Into<Indexed<T>> + PartialEq + Send + Sync + Debug + 'static,
    {
        T::from(self)
    }
}

// Implement `EventDataTransformer` for `InsertedIntoTreeEvent`
impl EventDataTransformer for InsertedIntoTreeEvent {
    fn transform<T>(self) -> T
    where
        T: From<Self> + Into<Indexed<T>> + PartialEq + Send + Sync + Debug + 'static,
    {
        T::from(self)
    }
}

/// Trait for getting decoders from different contracts depending on the event type
pub trait HasLogDecoder {
    /// Get the log decoder for a specific contract
    fn log_decoder(contract_address: Bech32ContractId, wallet: WalletUnlocked) -> LogDecoder;
}

impl HasLogDecoder for DispatchEvent {
    fn log_decoder(contract_address: Bech32ContractId, wallet: WalletUnlocked) -> LogDecoder {
        FuelMailboxContract::new(contract_address, wallet).log_decoder()
    }
}

impl HasLogDecoder for GasPaymentEvent {
    fn log_decoder(contract_address: Bech32ContractId, wallet: WalletUnlocked) -> LogDecoder {
        FuelIgpContract::new(contract_address, wallet).log_decoder()
    }
}

impl HasLogDecoder for InsertedIntoTreeEvent {
    fn log_decoder(contract_address: Bech32ContractId, wallet: WalletUnlocked) -> LogDecoder {
        FuelMerkleTreeHookContract::new(contract_address, wallet).log_decoder()
    }
}
