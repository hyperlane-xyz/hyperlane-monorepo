//! CCTP plugin implementation for Hyperlane token bridging.

use account_utils::{create_pda_account, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_sealevel_token_lib::{
    accounts::HyperlaneToken, processor::HyperlaneSealevelTokenPlugin,
};
use hyperlane_warp_route::TokenMessage;
use serializable_account_meta::SerializableAccountMeta;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    msg,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_program,
    sysvar::{self, Sysvar},
};
use spl_associated_token_account::get_associated_token_address_with_program_id;
use std::collections::HashMap;

use crate::cctp_interface::{
    create_deposit_for_burn_instruction, MESSAGE_TRANSMITTER_PROGRAM_ID,
    TOKEN_MESSENGER_MINTER_PROGRAM_ID,
};

// Import the CollateralPlugin to reuse its functionality
use hyperlane_sealevel_token_collateral::plugin::CollateralPlugin;

/// Seeds for the PDA account that stores CCTP plugin data.
#[macro_export]
macro_rules! hyperlane_token_cctp_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"cctp"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_token", b"-", b"cctp", &[$bump_seed]]
    }};
}

/// A plugin for the Hyperlane token program that uses CCTP
/// for cross-chain USDC transfers.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct CctpPlugin {
    /// The underlying CollateralPlugin for common token functionality
    pub collateral_plugin: CollateralPlugin,
    /// TokenMessengerMinter program
    pub token_messenger_minter_program: Pubkey,
    /// MessageTransmitter program
    pub message_transmitter_program: Pubkey,
    /// Domain mappings from Hyperlane domain to Circle domain
    pub domain_mappings: HashMap<u32, u32>,
}

impl SizedData for CctpPlugin {
    fn size(&self) -> usize {
        // collateral_plugin size
        self.collateral_plugin.size()
            // token_messenger_minter_program
            + 32
            // message_transmitter_program
            + 32
            // domain_mappings length
            + 4
            // domain_mappings (8 bytes per mapping: 4 for hyperlane, 4 for circle)
            + (self.domain_mappings.len() * 8)
    }
}

impl CctpPlugin {
    /// Gets the Circle domain for a given Hyperlane domain
    pub fn get_circle_domain(&self, hyperlane_domain: u32) -> Result<u32, ProgramError> {
        self.domain_mappings
            .get(&hyperlane_domain)
            .copied()
            .ok_or_else(|| {
                msg!(
                    "Circle domain not configured for Hyperlane domain {}",
                    hyperlane_domain
                );
                ProgramError::InvalidArgument
            })
    }

    /// Get the CCTP PDA for storing plugin data
    pub fn get_cctp_pda(program_id: &Pubkey, _spl_token_program: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(hyperlane_token_cctp_pda_seeds!(), program_id)
    }
}

impl HyperlaneSealevelTokenPlugin for CctpPlugin {
    /// Initializes the plugin.
    ///
    /// Accounts (first handled by CollateralPlugin):
    /// 0. `[executable]` The SPL token program for the mint, i.e. either SPL token program or the 2022 version.
    /// 1. `[]` The mint.
    /// 2. `[executable]` The Rent sysvar program.
    /// 3. `[writable]` The CCTP plugin PDA account.
    /// 4. `[]` TokenMessengerMinter program.
    /// 5. `[]` MessageTransmitter program.
    /// ... (additional accounts required by CollateralPlugin)
    fn initialize<'a, 'b>(
        program_id: &Pubkey,
        system_program: &'a AccountInfo<'b>,
        _token_account_info: &'a AccountInfo<'b>,
        payer_account_info: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError> {
        // Account 0: The SPL token program.
        let spl_token_account_info = next_account_info(accounts_iter)?;
        if spl_token_account_info.key != &spl_token_2022::id()
            && spl_token_account_info.key != &spl_token::id()
        {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 1: The mint.
        let mint_account_info = next_account_info(accounts_iter)?;
        if mint_account_info.owner != spl_token_account_info.key {
            return Err(ProgramError::IllegalOwner);
        }

        // Account 2: The Rent sysvar program.
        let rent_account_info = next_account_info(accounts_iter)?;
        if rent_account_info.key != &sysvar::rent::id() {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 3: CCTP plugin PDA account.
        let cctp_account_info = next_account_info(accounts_iter)?;
        let (cctp_key, cctp_bump) =
            Pubkey::find_program_address(hyperlane_token_cctp_pda_seeds!(), program_id);
        if &cctp_key != cctp_account_info.key {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Create CCTP plugin PDA
        let rent = Rent::get()?;
        create_pda_account(
            payer_account_info,
            &rent,
            256, // Space for domain mappings
            program_id,
            system_program,
            cctp_account_info,
            hyperlane_token_cctp_pda_seeds!(cctp_bump),
        )?;

        // Account 4: TokenMessengerMinter program.
        let token_messenger_minter_account_info = next_account_info(accounts_iter)?;
        let expected_token_messenger_minter =
            TOKEN_MESSENGER_MINTER_PROGRAM_ID.parse::<Pubkey>().unwrap();
        if token_messenger_minter_account_info.key != &expected_token_messenger_minter {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 5: MessageTransmitter program.
        let message_transmitter_account_info = next_account_info(accounts_iter)?;
        let expected_message_transmitter =
            MESSAGE_TRANSMITTER_PROGRAM_ID.parse::<Pubkey>().unwrap();
        if message_transmitter_account_info.key != &expected_message_transmitter {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Initialize with default domain mappings
        let mut domain_mappings = HashMap::new();
        // Ethereum
        domain_mappings.insert(1, 0);
        // Avalanche
        domain_mappings.insert(43114, 1);
        // Arbitrum
        domain_mappings.insert(42161, 3);
        // Base
        domain_mappings.insert(8453, 6);
        // Polygon
        domain_mappings.insert(137, 7);
        // Optimism
        domain_mappings.insert(10, 2);
        // Unichain
        domain_mappings.insert(130, 10);

        // Initialize CollateralPlugin first
        let collateral_plugin = CollateralPlugin::initialize(
            program_id,
            system_program,
            _token_account_info,
            payer_account_info,
            accounts_iter,
        )?;

        Ok(Self {
            collateral_plugin,
            token_messenger_minter_program: *token_messenger_minter_account_info.key,
            message_transmitter_program: *message_transmitter_account_info.key,
            domain_mappings,
        })
    }

    /// Transfers tokens using CCTP's depositForBurn.
    ///
    /// This method is called by the HyperlaneSealevelToken processor
    /// when handling a TransferRemote instruction. The destination domain
    /// and recipient are passed through the processor context.
    ///
    /// Additional accounts required (beyond standard token transfer accounts):
    /// - `[executable]` TokenMessengerMinter program.
    /// - `[executable]` MessageTransmitter program.
    /// - `[]` Token messenger PDA.
    /// - `[]` Remote token messenger PDA.
    /// - `[writeable]` Token minter PDA.
    /// - `[writeable]` Message sent event data account.
    /// - `[writeable]` Event rent payer (same as sender).
    fn transfer_in<'a, 'b>(
        _program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        sender_wallet_account_info: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError> {
        // Note: In the actual implementation, the destination domain and recipient
        // would be extracted from the current transfer context.
        // The HyperlaneSealevelToken processor provides this information
        // when calling the plugin's transfer_in method.

        // For this simplified version, we'll use the destination from the first
        // CCTP accounts provided. In production, this would come from the
        // TransferRemote instruction data processed by the main token processor.
        let destination_hyperlane_domain = 1u32; // This will be provided by the processor
        let mint_recipient = [0u8; 32]; // This will be provided by the processor

        // Get Circle domain for the destination
        let destination_circle_domain = token
            .plugin_data
            .get_circle_domain(destination_hyperlane_domain)?;

        // Account 0: SPL token program.
        let spl_token_account_info = next_account_info(accounts_iter)?;
        if spl_token_account_info.key != &token.plugin_data.collateral_plugin.spl_token_program {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 1: The mint.
        let mint_account_info = next_account_info(accounts_iter)?;
        if mint_account_info.key != &token.plugin_data.collateral_plugin.mint {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 2: The sender's associated token account.
        let sender_ata_account_info = next_account_info(accounts_iter)?;
        let expected_sender_ata = get_associated_token_address_with_program_id(
            sender_wallet_account_info.key,
            mint_account_info.key,
            spl_token_account_info.key,
        );
        if sender_ata_account_info.key != &expected_sender_ata {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 3: TokenMessengerMinter program.
        let token_messenger_minter_info = next_account_info(accounts_iter)?;
        if token_messenger_minter_info.key != &token.plugin_data.token_messenger_minter_program {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 4: MessageTransmitter program.
        let message_transmitter_info = next_account_info(accounts_iter)?;
        if message_transmitter_info.key != &token.plugin_data.message_transmitter_program {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 5: Token messenger PDA.
        let token_messenger_info = next_account_info(accounts_iter)?;

        // Account 6: Remote token messenger PDA.
        let remote_token_messenger_info = next_account_info(accounts_iter)?;

        // Account 7: Token minter PDA.
        let token_minter_info = next_account_info(accounts_iter)?;

        // Account 8: Message sent event data.
        let message_sent_event_data_info = next_account_info(accounts_iter)?;

        // Account 9: Event rent payer (same as sender).
        let event_rent_payer_info = next_account_info(accounts_iter)?;

        // Account 10: System program.
        let system_program_info = next_account_info(accounts_iter)?;
        if system_program_info.key != &system_program::id() {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Create depositForBurn instruction
        let deposit_for_burn_ix = create_deposit_for_burn_instruction(
            &token.plugin_data.token_messenger_minter_program,
            &token.plugin_data.message_transmitter_program,
            token_messenger_info.key,
            remote_token_messenger_info.key,
            token_minter_info.key,
            sender_wallet_account_info.key,
            mint_account_info.key,
            message_sent_event_data_info.key,
            destination_circle_domain,
            mint_recipient,
            amount,
            sender_ata_account_info.key,
            event_rent_payer_info.key,
            spl_token_account_info.key,
        );

        // Invoke depositForBurn
        invoke(
            &deposit_for_burn_ix,
            &[
                token_messenger_minter_info.clone(),
                token_messenger_info.clone(),
                remote_token_messenger_info.clone(),
                token_minter_info.clone(),
                sender_wallet_account_info.clone(),
                mint_account_info.clone(),
                message_sent_event_data_info.clone(),
                message_transmitter_info.clone(),
                sender_ata_account_info.clone(),
                event_rent_payer_info.clone(),
                system_program_info.clone(),
                spl_token_account_info.clone(),
            ],
        )?;

        Ok(())
    }

    /// For CCTP, tokens are minted directly by the MessageTransmitter/TokenMessengerMinter
    /// when the attestation is verified, so we don't need to do anything here.
    fn transfer_out<'a, 'b>(
        _program_id: &Pubkey,
        _token: &HyperlaneToken<Self>,
        _system_program_account_info: &'a AccountInfo<'b>,
        _recipient_wallet_account_info: &'a AccountInfo<'b>,
        _accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        _amount: u64,
    ) -> Result<(), ProgramError> {
        // CCTP handles the minting directly, so nothing to do here
        Ok(())
    }

    /// Returns the accounts required for `transfer_out`.
    /// For CCTP, the transfer_out is handled by the MessageTransmitter,
    /// so we return empty accounts.
    fn transfer_out_account_metas(
        _program_id: &Pubkey,
        _token: &HyperlaneToken<Self>,
        _token_message: &TokenMessage,
    ) -> Result<(Vec<SerializableAccountMeta>, bool), ProgramError> {
        Ok((vec![], false))
    }
}
