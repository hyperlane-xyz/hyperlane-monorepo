//! CCTP (Cross-Chain Transfer Protocol) interface definitions for Solana.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};

/// CCTP MessageTransmitter program V1 on Solana mainnet
pub const MESSAGE_TRANSMITTER_PROGRAM_ID: &str = "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd";

/// CCTP TokenMessengerMinter program V1 on Solana mainnet
pub const TOKEN_MESSENGER_MINTER_PROGRAM_ID: &str = "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3";

/// Parameters for the depositForBurn instruction
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct DepositForBurnParams {
    /// Amount to burn
    pub amount: u64,
    /// Destination domain (Circle domain)
    pub destination_domain: u32,
    /// Mint recipient on destination chain (32 bytes)
    pub mint_recipient: [u8; 32],
}

/// Instruction discriminators for TokenMessengerMinter
#[derive(BorshSerialize, BorshDeserialize)]
pub enum TokenMessengerMinterInstruction {
    /// depositForBurn instruction
    DepositForBurn(DepositForBurnParams),
}

/// PDA seeds for TokenMessengerMinter accounts
pub mod token_messenger_seeds {
    use solana_program::pubkey::Pubkey;

    /// Seeds for the token_messenger PDA
    pub const TOKEN_MESSENGER: &[&[u8]] = &[b"token_messenger"];

    /// Seeds for the remote_token_messenger PDA
    pub fn remote_token_messenger(domain: u32) -> Vec<Vec<u8>> {
        vec![
            b"remote_token_messenger".to_vec(),
            domain.to_le_bytes().to_vec(),
        ]
    }

    /// Seeds for the token_minter PDA
    pub const TOKEN_MINTER: &[&[u8]] = &[b"token_minter"];

    /// Seeds for the local_token PDA
    pub fn local_token(mint: &Pubkey) -> Vec<Vec<u8>> {
        vec![b"local_token".to_vec(), mint.to_bytes().to_vec()]
    }

    /// Seeds for the token_pair PDA
    pub fn token_pair(source_domain: u32, remote_token: &[u8; 32]) -> Vec<Vec<u8>> {
        vec![
            b"token_pair".to_vec(),
            source_domain.to_le_bytes().to_vec(),
            remote_token.to_vec(),
        ]
    }

    /// Seeds for the custody account
    pub fn custody(mint: &Pubkey) -> Vec<Vec<u8>> {
        vec![b"custody".to_vec(), mint.to_bytes().to_vec()]
    }

    /// Seeds for message sent event account
    pub const MESSAGE_SENT_EVENT_DATA: &[&[u8]] = &[b"message_sent_event_data"];

    /// Seeds for message sent event account with nonce
    pub fn message_sent_event_data_with_nonce(nonce: u64) -> Vec<Vec<u8>> {
        vec![
            b"message_sent_event_data".to_vec(),
            nonce.to_le_bytes().to_vec(),
        ]
    }
}

/// PDA seeds for MessageTransmitter accounts
pub mod message_transmitter_seeds {
    /// Seeds for used nonces
    pub fn used_nonces(source_domain: u32, nonce: u64) -> Vec<Vec<u8>> {
        vec![
            b"used_nonces".to_vec(),
            source_domain.to_le_bytes().to_vec(),
            nonce.to_le_bytes().to_vec(),
        ]
    }
}

/// Creates a depositForBurn instruction for the TokenMessengerMinter program
pub fn create_deposit_for_burn_instruction(
    token_messenger_minter_program: &Pubkey,
    message_transmitter_program: &Pubkey,
    token_messenger: &Pubkey,
    remote_token_messenger: &Pubkey,
    token_minter: &Pubkey,
    sender_authority: &Pubkey,
    burn_token_mint: &Pubkey,
    message_sent_event_data: &Pubkey,
    destination_domain: u32,
    mint_recipient: [u8; 32],
    amount: u64,
    burn_token_account: &Pubkey,
    event_rent_payer: &Pubkey,
    token_program: &Pubkey,
) -> Instruction {
    let params = DepositForBurnParams {
        amount,
        destination_domain,
        mint_recipient,
    };

    let data = borsh::to_vec(&TokenMessengerMinterInstruction::DepositForBurn(params))
        .expect("Failed to serialize instruction");

    let accounts = vec![
        AccountMeta::new_readonly(*token_messenger_minter_program, false),
        AccountMeta::new_readonly(*token_messenger, false),
        AccountMeta::new_readonly(*remote_token_messenger, false),
        AccountMeta::new(*token_minter, false),
        AccountMeta::new(*sender_authority, true),
        AccountMeta::new_readonly(*burn_token_mint, false),
        AccountMeta::new(*message_sent_event_data, false),
        AccountMeta::new_readonly(*message_transmitter_program, false),
        AccountMeta::new(*burn_token_account, false),
        AccountMeta::new(*event_rent_payer, true),
        AccountMeta::new_readonly(system_program::id(), false),
        AccountMeta::new_readonly(*token_program, false),
    ];

    Instruction {
        program_id: *token_messenger_minter_program,
        accounts,
        data,
    }
}

/// CCTP message format
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct CctpMessage {
    /// Version
    pub version: u32,
    /// Source domain
    pub source_domain: u32,
    /// Destination domain  
    pub destination_domain: u32,
    /// Nonce
    pub nonce: u64,
    /// Sender
    pub sender: [u8; 32],
    /// Recipient
    pub recipient: [u8; 32],
    /// Destination caller
    pub destination_caller: [u8; 32],
    /// Message body
    pub message_body: Vec<u8>,
}

/// Burn message format (message body for depositForBurn)
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone)]
pub struct BurnMessage {
    /// Version
    pub version: u32,
    /// Burn token address
    pub burn_token: [u8; 32],
    /// Mint recipient
    pub mint_recipient: [u8; 32],
    /// Amount
    pub amount: u128,
    /// Message sender
    pub message_sender: [u8; 32],
}
