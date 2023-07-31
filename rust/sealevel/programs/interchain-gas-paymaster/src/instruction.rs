//! Program instructions.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;

use solana_program::pubkey::Pubkey;

use crate::accounts::GasOracle;

/// The program instructions.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub enum Instruction {
    /// Initializes the program.
    Init,
    /// Initializes an IGP.
    InitIgp(InitIgp),
    /// Initializes an overhead IGP.
    InitOverheadIgp(InitOverheadIgp),
    /// Pays for gas.
    PayForGas(PayForGas),
    /// Quotes a gas payment.
    QuoteGasPayment(QuoteGasPayment),
    /// Transfers ownership of an IGP.
    TransferIgpOwnership(Option<Pubkey>),
    /// Transfers ownership of an overhead IGP.
    TransferOverheadIgpOwnership(Option<Pubkey>),
    /// Sets the beneficiary of an IGP.
    SetIgpBeneficiary(Pubkey),
    /// Sets destination gas overheads on an overhead IGP.
    SetDestinationGasOverheads(Vec<GasOverheadConfig>),
    /// Sets gas oracles on an IGP.
    SetGasOracleConfigs(Vec<GasOracleConfig>),
    /// Claims lamports from an IGP, sending them to the IGP's beneficiary.
    Claim,
}

/// Initializes an IGP.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InitIgp {
    /// A salt used for deriving the IGP PDA.
    pub salt: H256,
    /// The owner of the IGP.
    pub owner: Option<Pubkey>,
    /// The beneficiary of the IGP.
    pub beneficiary: Pubkey,
}

/// Initializes an overhead IGP.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct InitOverheadIgp {
    /// A salt used for deriving the overhead IGP PDA.
    pub salt: H256,
    /// The owner of the overhead IGP.
    pub owner: Option<Pubkey>,
    /// The inner IGP.
    pub inner: Pubkey,
}

/// Pays for gas.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct PayForGas {
    /// The message ID.
    pub message_id: H256,
    /// The destination domain.
    pub destination_domain: u32,
    /// The gas amount.
    pub gas_amount: u64,
}

/// Quotes a gas payment.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq)]
pub struct QuoteGasPayment {
    /// The destination domain.
    pub destination_domain: u32,
    /// The gas amount.
    pub gas_amount: u64,
}

/// A config for setting a destination gas overhead.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Clone)]
pub struct GasOverheadConfig {
    /// The destination domain.
    pub destination_domain: u32,
    /// The gas overhead.
    pub gas_overhead: Option<u64>,
}

/// A config for setting remote gas data.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Clone)]
pub struct GasOracleConfig {
    /// The destination domain.
    pub domain: u32,
    /// The gas oracle.
    pub gas_oracle: Option<GasOracle>,
}
