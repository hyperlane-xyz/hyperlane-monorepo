use access_control::AccessControl;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::H256;

use solana_program::{
    account_info::AccountInfo, instruction::AccountMeta, msg, program_error::ProgramError,
    pubkey::Pubkey,
};
use std::collections::HashMap;

use crate::router::HyperlaneRouterDispatch;

/// Gas router configuration for a single destination.
#[derive(Debug, Clone, PartialEq, BorshDeserialize, BorshSerialize)]
pub struct GasRouterConfig {
    /// The domain of the remote router.
    pub domain: u32,
    /// The remote router.
    pub gas: Option<u64>,
}

/// The Hyperlane gas router.
pub trait HyperlaneGasRouter {
    /// Returns the amount of gas required to send a message to the provided destination, if set.
    fn destination_gas(&self, destination: u32) -> Option<u64>;

    /// Sets the amount of gas required to send a message to the provided destination.
    fn set_destination_gas(&mut self, config: GasRouterConfig);

    /// Sets the amount of gas required to send a message to the provided destinations.
    fn set_destination_gas_configs(&mut self, configs: Vec<GasRouterConfig>) {
        configs
            .into_iter()
            .for_each(|config| self.set_destination_gas(config))
    }
}

/// The Hyperlane router pattern with setters restricted to the access control owner.
pub trait HyperlaneGasRouterAccessControl: HyperlaneGasRouter + AccessControl {
    /// Sets the destination gas if the provided `maybe_owner` is a signer and is the access control owner.
    /// Otherwise, returns an error.
    fn set_destination_gas_only_owner(
        &mut self,
        maybe_owner: &AccountInfo,
        config: GasRouterConfig,
    ) -> Result<(), ProgramError> {
        self.ensure_owner_signer(maybe_owner)?;
        self.set_destination_gas(config);
        Ok(())
    }

    /// Enrolls multiple destination gas configs if the provided `maybe_owner` is a signer and is the access control owner.
    /// Otherwise, returns an error.
    fn set_destination_gas_configs_only_owner(
        &mut self,
        maybe_owner: &AccountInfo,
        configs: Vec<GasRouterConfig>,
    ) -> Result<(), ProgramError> {
        self.ensure_owner_signer(maybe_owner)?;
        self.set_destination_gas_configs(configs);
        Ok(())
    }
}

// Auto-implement
impl<T> HyperlaneGasRouterAccessControl for T where T: HyperlaneGasRouter + AccessControl {}

/// The Hyperlane gas router pattern with a helper function to dispatch messages
/// to a remote routers & pay for gas with the configured gas amount.
#[allow(clippy::too_many_arguments)]
pub trait HyperlaneGasRouterDispatch: HyperlaneGasRouter + HyperlaneRouterDispatch {
    fn dispatch_with_gas(
        &self,
        program_id: &Pubkey,
        dispatch_authority_seeds: &[&[u8]],
        destination_domain: u32,
        message_body: Vec<u8>,
        dispatch_account_metas: Vec<AccountMeta>,
        dispatch_account_infos: &[AccountInfo],
        payment_account_metas: Vec<AccountMeta>,
        payment_account_infos: &[AccountInfo],
    ) -> Result<H256, ProgramError> {
        HyperlaneRouterDispatch::dispatch_with_gas(
            self,
            program_id,
            dispatch_authority_seeds,
            destination_domain,
            message_body,
            self.destination_gas(destination_domain)
                .ok_or(ProgramError::InvalidArgument)?,
            dispatch_account_metas,
            dispatch_account_infos,
            payment_account_metas,
            payment_account_infos,
        )
    }
}

// Auto-implement
impl<T> HyperlaneGasRouterDispatch for T where T: HyperlaneGasRouter + HyperlaneRouterDispatch {}

/// A default implementation of `HyperlaneGasRouter` for `HashMap<u32, u64>`.
impl HyperlaneGasRouter for HashMap<u32, u64> {
    /// Returns the amount of gas required to send a message to the provided destination, if set.
    fn destination_gas(&self, destination: u32) -> Option<u64> {
        self.get(&destination).cloned()
    }

    /// Sets the amount of gas required to send a message to the provided destination.
    fn set_destination_gas(&mut self, config: GasRouterConfig) {
        match config.gas {
            Some(gas) => {
                self.insert(config.domain, gas);
            }
            None => {
                self.remove(&config.domain);
            }
        }

        msg!("Set destination {} gas to: {:?}", config.domain, config.gas);
    }
}
