//! Processor logic shared by all Hyperlane Sealevel Token programs.

use access_control::AccessControl;
use account_utils::{create_pda_account, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{Decode, Encode, H256, U256};
use hyperlane_sealevel_connection_client::{
    gas_router::{GasRouterConfig, HyperlaneGasRouter, HyperlaneGasRouterAccessControl},
    router::{
        HyperlaneRouter, HyperlaneRouterAccessControl, HyperlaneRouterMessageRecipient,
        RemoteRouterConfig,
    },
    HyperlaneConnectionClient, HyperlaneConnectionClientSetterAccessControl,
};
use hyperlane_sealevel_fee::{
    accounts::FeeAccountPrefix,
    instruction::{Instruction as FeeInstruction, QuoteFee},
};
use hyperlane_sealevel_igp::{
    accounts::InterchainGasPaymasterType,
    instruction::{Instruction as IgpInstruction, PayForGas as IgpPayForGas},
};
use hyperlane_sealevel_mailbox::{
    instruction::{Instruction as MailboxInstruction, OutboxDispatch as MailboxOutboxDispatch},
    mailbox_message_dispatch_authority_pda_seeds, mailbox_process_authority_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::HandleInstruction;
use hyperlane_warp_route::TokenMessage;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{get_return_data, invoke, invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

/// Parsed IGP accounts for the deferred PayForGas CPI.
/// The variant determines the invocation mode.
enum IgpPaymentAccounts<'b> {
    /// Old flow: oracle-based pricing, plain `invoke`.
    Legacy {
        account_metas: Vec<AccountMeta>,
        account_infos: Vec<AccountInfo<'b>>,
    },
    /// New flow: offchain quote pricing, `invoke_signed` with dispatch_authority PDA.
    Quoted {
        account_metas: Vec<AccountMeta>,
        account_infos: Vec<AccountInfo<'b>>,
    },
}
use solana_system_interface::program as system_program;
use std::collections::HashMap;

use crate::{
    accounts::{FeeConfig, HyperlaneToken, HyperlaneTokenAccount},
    error::Error,
    instruction::{Init, TransferRemote},
};

/// Seeds relating to the PDA account with information about this warp route.
/// For convenience in getting the account metas required for handling messages,
/// this is the same as the `HANDLE_ACCOUNT_METAS_PDA_SEEDS` in the message
/// recipient interface.
#[macro_export]
macro_rules! hyperlane_token_pda_seeds {
    () => {{
        &[
            b"hyperlane_message_recipient",
            b"-",
            b"handle",
            b"-",
            b"account_metas",
        ]
    }};

    ($bump_seed:expr) => {{
        &[
            b"hyperlane_message_recipient",
            b"-",
            b"handle",
            b"-",
            b"account_metas",
            &[$bump_seed],
        ]
    }};
}

/// A plugin that handles token transfers for a Hyperlane Sealevel Token program.
pub trait HyperlaneSealevelTokenPlugin
where
    Self: BorshSerialize
        + BorshDeserialize
        + std::cmp::PartialEq
        + std::fmt::Debug
        + Default
        + Sized
        + SizedData,
{
    /// Initializes the plugin.
    fn initialize<'a, 'b>(
        program_id: &Pubkey,
        system_program: &'a AccountInfo<'b>,
        token_account: &'a AccountInfo<'b>,
        payer_account: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError>;

    /// Transfers tokens into the program, optionally collecting a fee.
    /// When `fee` is `Some((fee_amount, beneficiary))`, transfers the fee
    /// from the sender to the beneficiary account.
    fn transfer_in<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        sender_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
        fee: Option<(u64, &'a AccountInfo<'b>)>,
    ) -> Result<(), ProgramError>;

    /// Derives the fee beneficiary account pubkey for this plugin type.
    /// For SPL token plugins this is the ATA of (beneficiary_owner, mint, token_program).
    /// For the native plugin this is the raw beneficiary_owner pubkey.
    fn fee_beneficiary_pubkey(
        token: &HyperlaneToken<Self>,
        beneficiary_owner: &Pubkey,
    ) -> Result<Pubkey, ProgramError>;

    /// Transfers tokens out of the program.
    fn transfer_out<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        system_program: &'a AccountInfo<'b>,
        recipient_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError>;

    /// Gets the AccountMetas required by the `transfer_out` function.
    /// Returns (AccountMetas, whether recipient wallet must be writeable)
    fn transfer_out_account_metas(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        token_message: &TokenMessage,
    ) -> Result<(Vec<SerializableAccountMeta>, bool), ProgramError>;
}

/// Core functionality of a Hyperlane Sealevel Token program that uses
/// a plugin to handle token transfers.
pub struct HyperlaneSealevelToken<
    T: HyperlaneSealevelTokenPlugin
        + BorshDeserialize
        + BorshSerialize
        + std::cmp::PartialEq
        + std::fmt::Debug,
> {
    _plugin: std::marker::PhantomData<T>,
}

impl<T> HyperlaneSealevelToken<T>
where
    T: HyperlaneSealevelTokenPlugin
        + BorshSerialize
        + BorshDeserialize
        + std::cmp::PartialEq
        + std::fmt::Debug
        + Default,
{
    /// Initializes the program.
    ///
    /// Accounts:
    /// - 0: `[executable]` The system program.
    /// - 1: `[writable]` The token PDA account.
    /// - 2: `[writable]` The dispatch authority PDA account.
    /// - 3: `[signer]` The payer and access control owner.
    /// - 4..N: `[??..??]` Plugin-specific accounts.
    pub fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: System program
        let system_program_id = system_program::ID;
        let system_program = next_account_info(accounts_iter)?;
        if system_program.key != &system_program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 1: Token storage account
        let token_account = next_account_info(accounts_iter)?;
        let (token_key, token_bump) =
            Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);
        if &token_key != token_account.key {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !token_account.data_is_empty() || token_account.owner != &system_program_id {
            return Err(ProgramError::AccountAlreadyInitialized);
        }

        // Account 2: Dispatch authority PDA.
        let dispatch_authority_account = next_account_info(accounts_iter)?;
        let (dispatch_authority_key, dispatch_authority_bump) = Pubkey::find_program_address(
            mailbox_message_dispatch_authority_pda_seeds!(),
            program_id,
        );
        if *dispatch_authority_account.key != dispatch_authority_key {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !dispatch_authority_account.data_is_empty()
            || dispatch_authority_account.owner != &system_program_id
        {
            return Err(ProgramError::AccountAlreadyInitialized);
        }

        // Account 3: Payer
        let payer_account = next_account_info(accounts_iter)?;
        if !payer_account.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Get the Mailbox's process authority that is specific to this program
        // as a recipient.
        let (mailbox_process_authority, _mailbox_process_authority_bump) =
            Pubkey::find_program_address(
                mailbox_process_authority_pda_seeds!(program_id),
                &init.mailbox,
            );

        let plugin_data = T::initialize(
            program_id,
            system_program,
            token_account,
            payer_account,
            accounts_iter,
        )?;

        if accounts_iter.next().is_some() {
            return Err(ProgramError::from(Error::ExtraneousAccount));
        }

        let rent = Rent::get()?;

        let token: HyperlaneToken<T> = HyperlaneToken {
            bump: token_bump,
            mailbox: init.mailbox,
            mailbox_process_authority,
            dispatch_authority_bump,
            owner: Some(*payer_account.key),
            interchain_security_module: init.interchain_security_module,
            interchain_gas_paymaster: init.interchain_gas_paymaster,
            destination_gas: HashMap::new(),
            decimals: init.decimals,
            remote_decimals: init.remote_decimals,
            remote_routers: HashMap::new(),
            plugin_data,
            fee_config: None,
        };
        let token_account_data = HyperlaneTokenAccount::<T>::from(token);

        // Create token account PDA
        create_pda_account(
            payer_account,
            &rent,
            token_account_data.size(),
            program_id,
            system_program,
            token_account,
            hyperlane_token_pda_seeds!(token_bump),
        )?;

        // Create dispatch authority PDA
        create_pda_account(
            payer_account,
            &rent,
            0,
            program_id,
            system_program,
            dispatch_authority_account,
            mailbox_message_dispatch_authority_pda_seeds!(dispatch_authority_bump),
        )?;

        token_account_data.store(token_account, false)?;

        Ok(())
    }

    /// Transfers tokens to a remote.
    /// Calls the plugin's `transfer_in` function to transfer tokens in,
    /// then dispatches a message to the remote recipient.
    ///
    /// Accounts:
    /// - 0: `[executable]` The system program.
    /// - 1: `[executable]` The spl_noop program.
    /// - 2: `[]` The token PDA account.
    /// - 3: `[executable]` The mailbox program.
    /// - 4: `[writeable]` The mailbox outbox account.
    /// - 5: `[]` Message dispatch authority.
    /// - 6: `[signer]` The token sender and mailbox payer.
    /// - 7: `[signer]` Unique message / gas payment account.
    /// - 8: `[writeable]` Message storage PDA.
    ///   ---- If fee_config is Some ----
    /// - 9: `[executable]` The fee program.
    /// - 10: `[]` The fee account.
    /// - 11..M: Variable QuoteFee pass-through accounts (standing quote PDAs, route PDAs).
    /// - M+1: `[writeable]` Fee beneficiary (terminal sentinel).
    ///   ---- End if ----
    ///   ---- If using an IGP ----
    /// - `[executable]` The IGP program.
    /// - `[writeable]` The IGP program data.
    /// - `[writeable]` Gas payment PDA.
    /// - `[]` OPTIONAL - The Overhead IGP program, if the configured IGP is an Overhead IGP.
    /// - `[writeable]` The IGP account.
    ///   ---- End if ----
    /// - `[??..??]` Plugin-specific accounts.
    pub fn transfer_remote(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        xfer: TransferRemote,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: System program.
        let system_program_account = next_account_info(accounts_iter)?;
        if system_program_account.key != &system_program::ID {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 1: SPL Noop.
        let spl_noop = next_account_info(accounts_iter)?;
        if spl_noop.key != &account_utils::SPL_NOOP_PROGRAM_ID {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 2: Token storage account
        let token_account = next_account_info(accounts_iter)?;
        let token =
            HyperlaneTokenAccount::fetch(&mut &token_account.data.borrow()[..])?.into_inner();
        let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
        let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
        if token_account.key != &expected_token_key {
            return Err(ProgramError::InvalidArgument);
        }
        if token_account.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Resolve the enrolled router for the destination domain.
        let router = *token
            .router(xfer.destination_domain)
            .ok_or(ProgramError::InvalidArgument)?;

        // Delegate to the shared remote-dispatch helper.
        let remote_amount = Self::transfer_remote_to(
            program_id,
            &token,
            system_program_account,
            spl_noop,
            accounts_iter,
            xfer.destination_domain,
            xfer.recipient,
            router,
            xfer.amount_or_id,
        )?;

        msg!(
            "Warp route transfer completed to destination: {}, recipient: {}, remote_amount: {}",
            xfer.destination_domain,
            xfer.recipient,
            remote_amount
        );

        Ok(())
    }

    /// Shared remote-dispatch helper: validates mailbox accounts, optionally
    /// quotes and collects fees, calls plugin `transfer_in`, dispatches via
    /// mailbox CPI, and optionally pays IGP.
    ///
    /// The caller is responsible for validating system_program, spl_noop,
    /// loading the token, and resolving the router.
    ///
    /// Account consumption order (starting after spl_noop / token PDA):
    /// - Core: mailbox, outbox, dispatch authority, sender, unique message, dispatched message
    /// - Fee (if fee_config is Some): fee_program, fee_account, variable pass-through, fee_beneficiary
    /// - IGP (if configured): igp_program, igp_data, payment PDA, configured IGP, optional inner IGP
    /// - Plugin: transfer_in accounts
    ///
    /// When fee_config is None the fee section is skipped, preserving
    /// the existing Core → IGP → Plugin layout.
    #[allow(clippy::too_many_arguments)]
    pub fn transfer_remote_to<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<T>,
        system_program_account: &'a AccountInfo<'b>,
        spl_noop: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        destination_domain: u32,
        recipient: H256,
        router: H256,
        amount_or_id: U256,
    ) -> Result<U256, ProgramError> {
        // Mailbox program
        let mailbox_info = next_account_info(accounts_iter)?;
        if mailbox_info.key != &token.mailbox {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Mailbox Outbox data account.
        // No verification is performed here, the Mailbox will do that.
        let mailbox_outbox_account = next_account_info(accounts_iter)?;

        // Message dispatch authority
        let dispatch_authority_account = next_account_info(accounts_iter)?;
        let dispatch_authority_seeds: &[&[u8]] =
            mailbox_message_dispatch_authority_pda_seeds!(token.dispatch_authority_bump);
        let dispatch_authority_key =
            Pubkey::create_program_address(dispatch_authority_seeds, program_id)?;
        if *dispatch_authority_account.key != dispatch_authority_key {
            return Err(ProgramError::InvalidArgument);
        }

        // Sender account / mailbox payer
        let sender_wallet = next_account_info(accounts_iter)?;
        if !sender_wallet.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Unique message / gas payment account
        // Defer to the checks in the Mailbox / IGP, no need to verify anything here.
        let unique_message_account = next_account_info(accounts_iter)?;

        // Message storage PDA.
        // Similarly defer to the checks in the Mailbox to ensure account validity.
        let dispatched_message_pda = next_account_info(accounts_iter)?;

        // === Fee section (if fee_config is Some) ===
        // Consumed before IGP: Core → Fee → IGP → Plugin.
        // When fee_config is None, skipped — preserving Core → IGP → Plugin.
        let local_amount: u64 = amount_or_id
            .try_into()
            .map_err(|_| Error::IntegerOverflow)?;

        let fee = if token.fee_config.is_some() {
            let (fee_amount, fee_beneficiary) = Self::parse_fee_section_and_quote(
                token,
                sender_wallet,
                accounts_iter,
                destination_domain,
                recipient,
                local_amount,
                router,
            )?;
            Some((fee_amount, fee_beneficiary))
        } else {
            None
        };

        // === IGP accounts (saved for later CPI) ===

        let igp_payment_accounts = if let Some((igp_program_id, igp_account_type)) =
            token.interchain_gas_paymaster()
        {
            // The IGP program
            let igp_program_account = next_account_info(accounts_iter)?;
            if igp_program_account.key != igp_program_id {
                return Err(ProgramError::InvalidArgument);
            }

            // The IGP program data.
            // No verification is performed here, the IGP will do that.
            let igp_program_data_account = next_account_info(accounts_iter)?;

            // The gas payment PDA.
            // No verification is performed here, the IGP will do that.
            let igp_payment_pda_account = next_account_info(accounts_iter)?;

            // PayForGas CPI accounts [0..4] — shared prefix for both flows.
            //
            // 0. `[executable]` The system program.
            // 1. `[signer]` The payer.
            // 2. `[writeable]` The IGP program data.
            // 3. `[signer]` Unique gas payment account.
            // 4. `[writeable]` Gas payment PDA.
            let mut igp_payment_account_metas = vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(*sender_wallet.key, true),
                AccountMeta::new(*igp_program_data_account.key, false),
                AccountMeta::new_readonly(*unique_message_account.key, true),
                AccountMeta::new(*igp_payment_pda_account.key, false),
            ];
            let mut igp_payment_account_infos = vec![
                system_program_account.clone(),
                sender_wallet.clone(),
                igp_program_data_account.clone(),
                unique_message_account.clone(),
                igp_payment_pda_account.clone(),
            ];

            // Detect new flow vs old flow.
            //
            // Old flow iterator order:
            //   configured_igp, [inner_igp if OverheadIgp]
            //
            // New flow iterator order:
            //   sender_authority, quoted_sender,
            //   [variable quote PDAs],
            //   configured_igp (TERMINAL), [inner_igp if OverheadIgp]
            //
            // Detection: if next account is dispatch_authority → new flow.
            let configured_igp_key = igp_account_type.key();
            let is_new_flow = accounts_iter
                .as_slice()
                .first()
                .is_some_and(|acc| *acc.key == dispatch_authority_key);

            // New-flow-only accounts: sender_authority, quoted_sender,
            // and variable quote PDAs. Empty for old flow (extend is no-op).
            let mut new_flow_metas: Vec<AccountMeta> = Vec::new();
            let mut new_flow_infos: Vec<AccountInfo<'b>> = Vec::new();

            let configured_igp_account;
            if is_new_flow {
                // sender_authority (dispatch_authority PDA).
                let sender_authority = next_account_info(accounts_iter)?;
                new_flow_metas.push(AccountMeta::new_readonly(*sender_authority.key, true));
                new_flow_infos.push(sender_authority.clone());

                // quoted_sender (warp route program_id).
                let quoted_sender = next_account_info(accounts_iter)?;
                if quoted_sender.key != program_id {
                    return Err(ProgramError::InvalidArgument);
                }
                new_flow_metas.push(AccountMeta::new_readonly(*quoted_sender.key, false));
                new_flow_infos.push(quoted_sender.clone());

                // Variable quote accounts until terminal (configured_igp).
                // Mirrors fee section's sentinel pattern.
                const MAX_IGP_VARIABLE_ACCOUNTS: usize = 15;
                configured_igp_account = loop {
                    let next = next_account_info(accounts_iter)?;
                    if next.key == configured_igp_key {
                        break next; // TERMINAL
                    }
                    if new_flow_metas.len() >= MAX_IGP_VARIABLE_ACCOUNTS {
                        return Err(Error::ExtraneousAccount.into());
                    }

                    new_flow_metas.push(AccountMeta {
                        pubkey: *next.key,
                        is_signer: next.is_signer,
                        is_writable: next.is_writable,
                    });

                    new_flow_infos.push(next.clone());
                };
            } else {
                configured_igp_account = next_account_info(accounts_iter)?;
                if configured_igp_account.key != configured_igp_key {
                    return Err(ProgramError::InvalidArgument);
                }
            }

            // Shared: [5] igp_account (configured_igp for Igp,
            // inner_igp for OverheadIgp — always next after terminal).
            match igp_account_type {
                InterchainGasPaymasterType::Igp(_) => {
                    igp_payment_account_metas
                        .push(AccountMeta::new(*configured_igp_account.key, false));
                    igp_payment_account_infos.push(configured_igp_account.clone());
                }
                InterchainGasPaymasterType::OverheadIgp(_) => {
                    let inner_igp_account = next_account_info(accounts_iter)?;
                    igp_payment_account_metas.push(AccountMeta::new(*inner_igp_account.key, false));
                    igp_payment_account_infos.push(inner_igp_account.clone());
                }
            }

            // New flow: [6] sender_authority, [7] quoted_sender,
            // [8+] variable quote PDAs. No-op for old flow.
            igp_payment_account_metas.extend(new_flow_metas);
            igp_payment_account_infos.extend(new_flow_infos);

            // Shared: overhead at end (OverheadIgp only).
            // Old flow puts it at [6], new flow at [N].
            if matches!(igp_account_type, InterchainGasPaymasterType::OverheadIgp(_)) {
                igp_payment_account_metas.push(AccountMeta::new_readonly(
                    *configured_igp_account.key,
                    false,
                ));
                igp_payment_account_infos.push(configured_igp_account.clone());
            }

            Some(if is_new_flow {
                IgpPaymentAccounts::Quoted {
                    account_metas: igp_payment_account_metas,
                    account_infos: igp_payment_account_infos,
                }
            } else {
                IgpPaymentAccounts::Legacy {
                    account_metas: igp_payment_account_metas,
                    account_infos: igp_payment_account_infos,
                }
            })
        } else {
            None
        };

        let remote_amount = Self::convert_and_transfer_in(
            program_id,
            token,
            sender_wallet,
            accounts_iter,
            amount_or_id,
            fee,
        )?;

        if accounts_iter.next().is_some() {
            return Err(ProgramError::from(Error::ExtraneousAccount));
        }

        // The token message body, which specifies the remote_amount.
        let token_transfer_message = TokenMessage::new(recipient, remote_amount, vec![]).to_vec();

        // Build mailbox dispatch CPI with explicit router as recipient.
        let dispatch_instruction = MailboxInstruction::OutboxDispatch(MailboxOutboxDispatch {
            sender: *program_id,
            destination_domain,
            recipient: router,
            message_body: token_transfer_message,
        });
        let dispatch_account_metas = vec![
            AccountMeta::new(*mailbox_outbox_account.key, false),
            AccountMeta::new_readonly(*dispatch_authority_account.key, true),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
            AccountMeta::new(*sender_wallet.key, true),
            AccountMeta::new_readonly(*unique_message_account.key, true),
            AccountMeta::new(*dispatched_message_pda.key, false),
        ];
        let dispatch_account_infos = &[
            mailbox_outbox_account.clone(),
            dispatch_authority_account.clone(),
            system_program_account.clone(),
            spl_noop.clone(),
            sender_wallet.clone(),
            unique_message_account.clone(),
            dispatched_message_pda.clone(),
        ];

        let mailbox_ixn = Instruction {
            program_id: token.mailbox,
            data: dispatch_instruction
                .into_instruction_data()
                .map_err(|_| ProgramError::BorshIoError)?,
            accounts: dispatch_account_metas,
        };
        invoke_signed(
            &mailbox_ixn,
            dispatch_account_infos,
            &[dispatch_authority_seeds],
        )?;

        // Verify mailbox set return data (sanity check — always true after dispatch).
        let (returning_program_id, returned_data) =
            get_return_data().ok_or(ProgramError::InvalidArgument)?;
        if returning_program_id != token.mailbox {
            return Err(ProgramError::InvalidArgument);
        }

        // Pay for gas if IGP is configured.
        if let Some(igp_payment) = igp_payment_accounts {
            let (igp_program_id, _) = token
                .interchain_gas_paymaster()
                .ok_or(ProgramError::InvalidArgument)?;

            let message_id =
                H256::try_from_slice(&returned_data).map_err(|_| ProgramError::InvalidArgument)?;

            let destination_gas = token
                .destination_gas(destination_domain)
                .ok_or(ProgramError::InvalidArgument)?;

            match igp_payment {
                IgpPaymentAccounts::Legacy {
                    account_metas,
                    account_infos,
                } => {
                    let igp_ixn = Instruction::new_with_borsh(
                        *igp_program_id,
                        &IgpInstruction::PayForGas(IgpPayForGas {
                            message_id,
                            destination_domain,
                            gas_amount: destination_gas,
                        }),
                        account_metas,
                    );

                    invoke(&igp_ixn, &account_infos)?;
                }
                IgpPaymentAccounts::Quoted {
                    account_metas,
                    account_infos,
                } => {
                    let igp_ixn = Instruction::new_with_borsh(
                        *igp_program_id,
                        &IgpInstruction::PayForGas(IgpPayForGas {
                            message_id,
                            destination_domain,
                            gas_amount: destination_gas,
                        }),
                        account_metas,
                    );

                    invoke_signed(&igp_ixn, &account_infos, &[dispatch_authority_seeds])?;
                }
            }
        }

        Ok(remote_amount)
    }

    /// Parses the fee section from the accounts iterator, CPIs QuoteFee,
    /// and returns the fee amount and beneficiary account reference.
    ///
    /// Assumes `token.fee_config` is `Some`. The caller must check before calling.
    ///
    /// Accounts consumed from the iterator:
    /// - fee_program (executable)
    /// - fee_account (owned by fee_program)
    /// - variable QuoteFee pass-through accounts (until terminal)
    /// - fee_beneficiary (terminal sentinel)
    #[allow(clippy::too_many_arguments)]
    pub fn parse_fee_section_and_quote<'a, 'b>(
        token: &HyperlaneToken<T>,
        sender_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        destination_domain: u32,
        recipient: H256,
        amount: u64,
        target_router: H256,
    ) -> Result<(u64, &'a AccountInfo<'b>), ProgramError> {
        let fee_config = token
            .fee_config
            .as_ref()
            .ok_or(ProgramError::InvalidArgument)?;

        // Consume fee_program account.
        let fee_program_account = next_account_info(accounts_iter)?;
        if fee_program_account.key != &fee_config.fee_program {
            return Err(ProgramError::InvalidArgument);
        }
        if !fee_program_account.executable {
            return Err(ProgramError::InvalidAccountData);
        }

        // Consume fee_account.
        let fee_account_info = next_account_info(accounts_iter)?;
        if fee_account_info.key != &fee_config.fee_account {
            return Err(ProgramError::InvalidArgument);
        }
        if fee_account_info.owner != &fee_config.fee_program {
            return Err(Error::FeeAccountOwnerMismatch.into());
        }

        // Read beneficiary from fee account prefix (bump + owner + beneficiary only).
        let fee_prefix = FeeAccountPrefix::parse_from(&fee_account_info.data.borrow())?;
        let beneficiary_owner = fee_prefix.beneficiary;

        // Derive the terminal fee beneficiary pubkey for this plugin type.
        let expected_fee_beneficiary = T::fee_beneficiary_pubkey(token, &beneficiary_owner)?;

        // Collect variable QuoteFee pass-through accounts until the terminal
        // (fee_beneficiary). Start CPI account lists with fee_account + sender.
        //
        // Safety bound: cap variable accounts to prevent unbounded consumption,
        // especially important in CC-local where accounts after the fee section
        // belong to the forwarded HandleLocal CPI.
        const MAX_FEE_VARIABLE_ACCOUNTS: usize = 15;

        let mut quote_account_infos = vec![fee_account_info.clone(), sender_wallet.clone()];
        let mut quote_account_metas = vec![
            AccountMeta::new_readonly(*fee_account_info.key, false),
            AccountMeta::new(*sender_wallet.key, true),
        ];

        let mut variable_count = 0usize;
        let fee_beneficiary_account = loop {
            let next = next_account_info(accounts_iter)?;
            if next.key == &expected_fee_beneficiary {
                break next;
            }

            variable_count += 1;
            if variable_count > MAX_FEE_VARIABLE_ACCOUNTS {
                return Err(Error::FeeBeneficiaryNotFound.into());
            }

            quote_account_infos.push(next.clone());
            quote_account_metas.push(AccountMeta {
                pubkey: *next.key,
                is_signer: next.is_signer,
                is_writable: next.is_writable,
            });
        };

        // Build and invoke QuoteFee CPI.
        let quote_fee_ixn = FeeInstruction::QuoteFee(QuoteFee {
            destination_domain,
            recipient,
            amount,
            target_router,
        });
        let cpi_instruction = Instruction {
            program_id: fee_config.fee_program,
            data: quote_fee_ixn
                .into_instruction_data()
                .map_err(|_| ProgramError::BorshIoError)?,
            accounts: quote_account_metas,
        };
        invoke(&cpi_instruction, &quote_account_infos)?;

        // Read return data IMMEDIATELY — before any subsequent CPI overwrites it.
        let (returning_program_id, returned_data) =
            get_return_data().ok_or(Error::InvalidFeeReturnData)?;
        if returning_program_id != fee_config.fee_program {
            return Err(Error::InvalidFeeReturnData.into());
        }
        let fee_amount = u64::from_le_bytes(
            returned_data
                .as_slice()
                .try_into()
                .map_err(|_| Error::InvalidFeeReturnData)?,
        );

        Ok((fee_amount, fee_beneficiary_account))
    }

    /// Converts amount from local to remote decimals and calls plugin
    /// `transfer_in` with an optional fee. Returns `remote_amount` for
    /// the caller to build `TokenMessage`.
    pub fn convert_and_transfer_in<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<T>,
        sender_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount_or_id: U256,
        fee: Option<(u64, &'a AccountInfo<'b>)>,
    ) -> Result<U256, ProgramError> {
        // The amount denominated in the local decimals.
        let local_amount: u64 = amount_or_id
            .try_into()
            .map_err(|_| Error::IntegerOverflow)?;
        // Convert to the remote number of decimals, which is universally understood
        // by the remote routers as the number of decimals used by the message amount.
        let remote_amount = token.local_amount_to_remote_amount(local_amount)?;

        T::transfer_in(
            program_id,
            token,
            sender_wallet,
            accounts_iter,
            local_amount,
            fee,
        )?;

        Ok(remote_amount)
    }

    /// Accounts:
    /// - 0: `[signer]` Mailbox processor authority specific to this program.
    /// - 1: `[executable]` system_program
    /// - 2: `[]` hyperlane_token storage
    /// - 3: `[depends on plugin]` recipient wallet address
    /// - 4..N: `[??..??]` Plugin-specific accounts.
    pub fn transfer_from_remote(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        xfer: HandleInstruction,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        let mut message_reader = std::io::Cursor::new(xfer.message);
        let message = TokenMessage::read_from(&mut message_reader)
            .map_err(|_err| ProgramError::from(Error::MessageDecodeError))?;

        // Account 0: Mailbox authority
        // This is verified further below.
        let process_authority_account = next_account_info(accounts_iter)?;

        // Account 1: System program
        let system_program = next_account_info(accounts_iter)?;
        if system_program.key != &system_program::ID {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 2: Token account
        let token_account = next_account_info(accounts_iter)?;
        let token =
            HyperlaneTokenAccount::fetch(&mut &token_account.data.borrow()[..])?.into_inner();
        let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
        let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
        if token_account.key != &expected_token_key {
            return Err(ProgramError::InvalidArgument);
        }
        if token_account.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 3: Recipient wallet
        let recipient_wallet = next_account_info(accounts_iter)?;
        let expected_recipient = Pubkey::new_from_array(message.recipient().into());
        if recipient_wallet.key != &expected_recipient {
            return Err(ProgramError::InvalidArgument);
        }

        // Verify the authenticity of the message.
        // This ensures the `process_authority_account` is valid and a signer,
        // and that the sender is the remote router for the origin.
        token.ensure_valid_router_message(process_authority_account, xfer.origin, &xfer.sender)?;

        // The amount denominated in the remote decimals.
        let remote_amount = message.amount();
        // Convert to the local number of decimals.
        let local_amount: u64 = token.remote_amount_to_local_amount(remote_amount)?;

        // Transfer the `local_amount` of tokens out.
        T::transfer_out(
            program_id,
            &*token,
            system_program,
            recipient_wallet,
            accounts_iter,
            local_amount,
        )?;

        if accounts_iter.next().is_some() {
            return Err(ProgramError::from(Error::ExtraneousAccount));
        }

        msg!(
            "Warp route transfer completed from origin: {}, recipient: {}, remote_amount: {}",
            xfer.origin,
            recipient_wallet.key,
            remote_amount
        );

        Ok(())
    }

    /// Gets the account metas required by the `HandleInstruction` instruction,
    /// serializes them, and sets them as return data.
    ///
    /// Accounts:
    /// 0.   `[]` The token PDA, which is the PDA with the seeds `HANDLE_ACCOUNT_METAS_PDA_SEEDS`.
    pub fn transfer_from_remote_account_metas(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        transfer: HandleInstruction,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        let mut message_reader = std::io::Cursor::new(transfer.message);
        let message = TokenMessage::read_from(&mut message_reader)
            .map_err(|_err| ProgramError::from(Error::MessageDecodeError))?;

        // Account 0: Token account.
        let token_account_info = next_account_info(accounts_iter)?;
        let token = HyperlaneToken::verify_account_and_fetch_inner(program_id, token_account_info)?;

        let (transfer_out_account_metas, writeable_recipient) =
            T::transfer_out_account_metas(program_id, &token, &message)?;

        let mut accounts: Vec<SerializableAccountMeta> = vec![
            AccountMeta::new_readonly(system_program::ID, false).into(),
            AccountMeta::new_readonly(*token_account_info.key, false).into(),
            AccountMeta {
                pubkey: Pubkey::new_from_array(message.recipient().into()),
                is_signer: false,
                is_writable: writeable_recipient,
            }
            .into(),
        ];
        accounts.extend(transfer_out_account_metas);

        // Wrap it in the SimulationReturnData because serialized account_metas
        // may end with zero byte(s), which are incorrectly truncated as
        // simulated transaction return data.
        // See `SimulationReturnData` for details.
        let bytes = borsh::to_vec(&SimulationReturnData::new(accounts))
            .map_err(|_| ProgramError::BorshIoError)?;
        set_return_data(&bytes[..]);

        Ok(())
    }

    /// Enrolls a remote router.
    ///
    /// Accounts:
    /// 0. `[executable]` The system program.
    /// 1. `[writeable]` The token PDA account.
    /// 2. `[signer]` The owner.
    pub fn enroll_remote_router(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        config: RemoteRouterConfig,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: System program. Only used if a realloc / rent exemption top up occurs.
        let system_program = next_account_info(accounts_iter)?;
        if system_program.key != &system_program::ID {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 1: Token account
        let token_account = next_account_info(accounts_iter)?;
        let mut token =
            HyperlaneTokenAccount::fetch(&mut &token_account.data.borrow()[..])?.into_inner();
        let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
        let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
        if token_account.key != &expected_token_key {
            return Err(ProgramError::InvalidArgument);
        }
        if token_account.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 2: Owner
        let owner_account = next_account_info(accounts_iter)?;

        // This errors if owner_account is not really the owner.
        token.enroll_remote_router_only_owner(owner_account, config)?;

        // Store the updated token account and realloc if necessary.
        HyperlaneTokenAccount::<T>::from(token).store_with_rent_exempt_realloc(
            token_account,
            &Rent::get()?,
            owner_account,
            system_program,
        )?;

        Ok(())
    }

    /// Enrolls remote routers.
    ///
    /// Accounts:
    /// 0. `[executable]` The system program.
    /// 1. `[writeable]` The token PDA account.
    /// 2. `[signer]` The owner.
    pub fn enroll_remote_routers(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        configs: Vec<RemoteRouterConfig>,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: System program. Only used if a realloc / rent exemption top up occurs.
        let system_program = next_account_info(accounts_iter)?;
        if system_program.key != &system_program::ID {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 1: Token account
        let token_account = next_account_info(accounts_iter)?;
        let mut token =
            HyperlaneTokenAccount::fetch(&mut &token_account.data.borrow()[..])?.into_inner();
        let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
        let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
        if token_account.key != &expected_token_key {
            return Err(ProgramError::InvalidArgument);
        }
        if token_account.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 2: Owner
        let owner_account = next_account_info(accounts_iter)?;

        // This errors if owner_account is not really the owner.
        token.enroll_remote_routers_only_owner(owner_account, configs)?;

        // Store the updated token account and realloc if necessary.
        HyperlaneTokenAccount::<T>::from(token).store_with_rent_exempt_realloc(
            token_account,
            &Rent::get()?,
            owner_account,
            system_program,
        )?;

        Ok(())
    }

    /// Transfers ownership.
    ///
    /// Accounts:
    /// 0. `[writeable]` The token PDA account.
    /// 1. `[signer]` The current owner.
    pub fn transfer_ownership(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        new_owner: Option<Pubkey>,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: Token account
        let token_account = next_account_info(accounts_iter)?;
        let mut token = HyperlaneToken::verify_account_and_fetch_inner(program_id, token_account)?;

        // Account 1: Owner
        let owner_account = next_account_info(accounts_iter)?;

        // This errors if owner_account is not really the owner.
        token.transfer_ownership(owner_account, new_owner)?;

        // Store the updated token account. No need to realloc, the size for the owner is the same.
        HyperlaneTokenAccount::<T>::from(token).store(token_account, false)?;

        Ok(())
    }

    /// Gets the interchain security module.
    ///
    /// Accounts:
    /// 0. `[]` The token PDA account.
    pub fn interchain_security_module(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: Token account
        let token_account = next_account_info(accounts_iter)?;
        let token = HyperlaneToken::<T>::verify_account_and_fetch_inner(program_id, token_account)?;

        // Set the return data to the serialized Option<Pubkey> representing
        // the ISM.
        token.set_interchain_security_module_return_data();

        Ok(())
    }

    /// Gets the account metas required to get the ISM, serializes them,
    /// and sets them as return data.
    ///
    /// Accounts:
    ///   None
    pub fn interchain_security_module_account_metas(program_id: &Pubkey) -> ProgramResult {
        let (token_key, _token_bump) =
            Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);

        let account_metas: Vec<SerializableAccountMeta> =
            vec![AccountMeta::new_readonly(token_key, false).into()];

        // Wrap it in the SimulationReturnData because serialized account_metas
        // may end with zero byte(s), which are incorrectly truncated as
        // simulated transaction return data.
        // See `SimulationReturnData` for details.
        let bytes = borsh::to_vec(&SimulationReturnData::new(account_metas))
            .map_err(|_| ProgramError::BorshIoError)?;
        set_return_data(&bytes[..]);

        Ok(())
    }

    /// Lets the owner set the interchain security module.
    ///
    /// Accounts:
    /// 0. `[writeable]` The token PDA account.
    /// 1. `[signer]` The access control owner.
    pub fn set_interchain_security_module(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        ism: Option<Pubkey>,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: Token account
        let token_account = next_account_info(accounts_iter)?;
        let mut token = HyperlaneToken::verify_account_and_fetch_inner(program_id, token_account)?;

        // Account 1: Owner
        let owner_account = next_account_info(accounts_iter)?;

        // This errors if owner_account is not really the owner.
        token.set_interchain_security_module_only_owner(owner_account, ism)?;

        // Store the updated token account. No need to realloc, the size for the ISM is the same.
        HyperlaneTokenAccount::<T>::from(token).store(token_account, false)?;

        Ok(())
    }

    /// Lets the owner set destination gas configs.
    ///
    /// Accounts:
    /// 0. `[executable]` The system program.
    /// 1. `[writeable]` The token PDA account.
    /// 2. `[signer]` The access control owner.
    pub fn set_destination_gas_configs(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        configs: Vec<GasRouterConfig>,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: System program. Only used if a realloc / rent exemption top up occurs.
        let system_program = next_account_info(accounts_iter)?;
        if system_program.key != &system_program::ID {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 1: Token account
        let token_account = next_account_info(accounts_iter)?;
        let mut token = HyperlaneToken::verify_account_and_fetch_inner(program_id, token_account)?;

        // Account 2: Owner
        let owner_account = next_account_info(accounts_iter)?;

        // This errors if owner_account is not really the owner.
        token.set_destination_gas_configs_only_owner(owner_account, configs)?;

        // Store the updated token account and realloc if necessary.
        HyperlaneTokenAccount::<T>::from(token).store_with_rent_exempt_realloc(
            token_account,
            &Rent::get()?,
            owner_account,
            system_program,
        )?;

        Ok(())
    }

    /// Lets the owner set the interchain gas paymaster.
    ///
    /// Accounts:
    /// 0. `[writeable]` The token PDA account.
    /// 1. `[signer]` The access control owner.
    pub fn set_interchain_gas_paymaster(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        igp: Option<(Pubkey, InterchainGasPaymasterType)>,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: Token account
        let token_account = next_account_info(accounts_iter)?;
        let mut token = HyperlaneToken::verify_account_and_fetch_inner(program_id, token_account)?;

        // Account 1: Owner
        let owner_account = next_account_info(accounts_iter)?;

        // This errors if owner_account is not really the owner.
        token.set_interchain_gas_paymaster_only_owner(owner_account, igp)?;

        // Store the updated token account. No need to realloc, the size for the ISM is the same.
        HyperlaneTokenAccount::<T>::from(token).store(token_account, false)?;

        Ok(())
    }

    /// Lets the owner set the fee configuration.
    ///
    /// Accounts:
    /// 0. `[executable]` The system program.
    /// 1. `[writeable]` The token PDA account.
    /// 2. `[signer]` The access control owner.
    ///
    /// When fee_config is Some:
    ///
    /// 3. `[executable]` The fee program.
    /// 4. `[]` The fee account (owned by fee program).
    pub fn set_fee_config(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        fee_config: Option<FeeConfig>,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: System program. Only used if a realloc / rent exemption top up occurs.
        let system_program = next_account_info(accounts_iter)?;
        if system_program.key != &system_program::ID {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 1: Token account
        let token_account = next_account_info(accounts_iter)?;
        let mut token = HyperlaneToken::verify_account_and_fetch_inner(program_id, token_account)?;

        // Account 2: Owner
        let owner_account = next_account_info(accounts_iter)?;
        token.ensure_owner_signer(owner_account)?;

        // Validate fee config accounts when setting (not clearing).
        if let Some(ref cfg) = fee_config {
            // Account 3: Fee program — must match instruction data and be executable.
            let fee_program_info = next_account_info(accounts_iter)?;
            if fee_program_info.key != &cfg.fee_program || !fee_program_info.executable {
                return Err(ProgramError::InvalidArgument);
            }

            // Account 4: Fee account — must match instruction data, be owned by
            // fee program, and contain a valid fee account prefix.
            let fee_account_info = next_account_info(accounts_iter)?;
            if fee_account_info.key != &cfg.fee_account
                || fee_account_info.owner != &cfg.fee_program
            {
                return Err(ProgramError::InvalidArgument);
            }
            FeeAccountPrefix::parse_from(&fee_account_info.data.borrow())?;
        }

        token.fee_config = fee_config;

        // Store with realloc since fee_config may change the account size.
        HyperlaneTokenAccount::<T>::from(token).store_with_rent_exempt_realloc(
            token_account,
            &Rent::get()?,
            owner_account,
            system_program,
        )?;

        Ok(())
    }
}
