#![allow(warnings)] // FIXME remove

use hyperlane_core::{Decode as _, H256, HyperlaneMessage, U256};
use tracing::error;

use crate::mailbox_message_inspector::{Error, Inspection, Inspector};
use crate::{hyperlane_token_erc20_pda_seeds, hyperlane_token_mint_pda_seeds};
use crate::solana::{
    instruction::AccountMeta,
    pubkey::Pubkey
};

// FIXME import from solana libs once test deployment fixed. Might also need to fix dependency
// conflicts?
mod solana {
    use std::str::FromStr as _;

    use crate::solana::pubkey::Pubkey;

    // spl_noop.so
    //     GpiNbGLpyroc8dFKPhK55eQhhvWn3XUaXJFp5fk5aXUs
    // spl_token.so
    //     GEDyaRBxUxCnA7zU6Uh4KyYnZxQQHUjjdpUzhsK6kZe2
    // spl_token_2022.so
    //     4Rns2H5bzBkNX7BQSj52pbuwokA4BLrNN1mo1FvEDAFf
    // spl_associated_token_account.so
    //     J7CTyNrJn3vnsJfKkVWFXHyP8Wjj8RU9w1GNfZa1d2hH
    // hyperlane_sealevel_token.so
    //     3MzUPjP5LEkiHH82nEAe28Xtz9ztuMqWc8UmuKxrpVQH
    // hyperlane_sealevel_mailbox.so
    //     692KZJaoe2KRcD6uhCQDLLXnLNA5ZLnfvdqjE4aX9iu1
    // hyperlane_sealevel_recipient_echo.so
    //     FZ8hyduJy4GQAfBu9zEiuQtk429Gjc6inwHgEW5MvsEm
    // hyperlane_sealevel_ism_rubber_stamp.so
    //     F6dVnLFioQ8hKszqPsmjWPwHn2dJfebgMfztWrzL548V
    lazy_static::lazy_static! {
        pub static ref SYSTEM_PROGRAM_ID: Pubkey =
            Pubkey::from_str("11111111111111111111111111111111").unwrap();
        pub static ref SPL_NOOP_ID: Pubkey =
            Pubkey::from_str("GpiNbGLpyroc8dFKPhK55eQhhvWn3XUaXJFp5fk5aXUs").unwrap();
        pub static ref SPL_TOKEN_2022_ID: Pubkey =
            Pubkey::from_str("4Rns2H5bzBkNX7BQSj52pbuwokA4BLrNN1mo1FvEDAFf").unwrap();
        pub static ref SPL_ASSOCIATED_TOKEN_ACCOUNT_ID: Pubkey =
            Pubkey::from_str("J7CTyNrJn3vnsJfKkVWFXHyP8Wjj8RU9w1GNfZa1d2hH").unwrap();
    }

    pub fn get_associated_token_address_with_program_id(
        wallet_address: &Pubkey,
        token_mint_address: &Pubkey,
        token_program_id: &Pubkey,
    ) -> Pubkey {
        get_associated_token_address_and_bump_seed(
            wallet_address,
            token_mint_address,
            &SPL_ASSOCIATED_TOKEN_ACCOUNT_ID,
            token_program_id,
        )
        .0
    }

    fn get_associated_token_address_and_bump_seed(
        wallet_address: &Pubkey,
        token_mint_address: &Pubkey,
        program_id: &Pubkey,
        token_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        get_associated_token_address_and_bump_seed_internal(
            wallet_address,
            token_mint_address,
            program_id,
            token_program_id,
        )
    }

    fn get_associated_token_address_and_bump_seed_internal(
        wallet_address: &Pubkey,
        token_mint_address: &Pubkey,
        program_id: &Pubkey,
        token_program_id: &Pubkey,
    ) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[
                &wallet_address.to_bytes(),
                &token_program_id.to_bytes(),
                &token_mint_address.to_bytes(),
            ],
            program_id,
        )
    }
}

// FIXME Pull in from token contract lib
mod token_contract {
    use borsh::{BorshDeserialize, BorshSerialize};
    use hyperlane_core::{Decode, Encode, H256, HyperlaneProtocolError, U256};

    #[macro_export]
    macro_rules! hyperlane_token_erc20_pda_seeds {
        ($token_name:expr, $token_symbol:expr) => {{
            &[
                b"hyperlane_token",
                b"-",
                $token_name.as_bytes(),
                b"-",
                $token_symbol.as_bytes(),
                b"-",
                b"erc20",
            ]
        }};

        ($token_name:expr, $token_symbol:expr, $bump_seed:expr) => {{
            &[
                b"hyperlane_token",
                b"-",
                $token_name.as_bytes(),
                b"-",
                $token_symbol.as_bytes(),
                b"-",
                b"erc20",
                &[$bump_seed],
            ]
        }};
    }

    #[macro_export]
    macro_rules! hyperlane_token_mint_pda_seeds {
        ($token_name:expr, $token_symbol:expr) => {{
            &[
                b"hyperlane_token",
                b"-",
                $token_name.as_bytes(),
                b"-",
                $token_symbol.as_bytes(),
                b"-",
                b"mint",
            ]
        }};

        ($token_name:expr, $token_symbol:expr, $bump_seed:expr) => {{
            &[
                b"hyperlane_token",
                b"-",
                $token_name.as_bytes(),
                b"-",
                $token_symbol.as_bytes(),
                b"-",
                b"mint",
                &[$bump_seed],
            ]
        }};
    }

    #[derive(Debug)]
    pub struct TokenMessage {
        recipient: H256,
        amount_or_id: U256,
        metadata: Vec<u8>,
    }

    impl Encode for TokenMessage {
        fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
        where
            W: std::io::Write,
        {
            writer.write_all(self.recipient.as_ref())?;

            let mut amount_or_id = [0_u8; 32];
            self.amount_or_id.to_big_endian(&mut amount_or_id);
            writer.write_all(&amount_or_id)?;

            writer.write_all(&self.metadata)?;

            Ok(32 + 32 + self.metadata.len())
        }
    }

    impl Decode for TokenMessage {
        fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
        where
            R: std::io::Read,
        {
            let mut recipient = H256::zero();
            reader.read_exact(recipient.as_mut())?;

            let mut amount_or_id = [0_u8; 32];
            reader.read_exact(&mut amount_or_id)?;
            let amount_or_id = U256::from_big_endian(&amount_or_id);

            let mut metadata = vec![];
            reader.read_to_end(&mut metadata)?;

            Ok(Self {
                recipient,
                amount_or_id: U256::from(amount_or_id),
                metadata,
            })
        }
    }

    impl TokenMessage {
        pub fn new_erc20(recipient: H256, amount: U256, metadata: Vec<u8>) -> Self {
            Self {
                recipient,
                amount_or_id: amount,
                metadata,
            }
        }

        pub fn new_erc721(recipient: H256, id: U256, metadata: Vec<u8>) -> Self {
            Self {
                recipient,
                amount_or_id: id,
                metadata,
            }
        }

        pub fn recipient(&self) -> H256 {
            self.recipient
        }

        pub fn amount(&self) ->  U256 {
            self.amount_or_id
        }

        pub fn token_id(&self) -> U256 {
            self.amount_or_id
        }

        pub fn metadata(&self) -> &[u8] {
            &self.metadata
        }
    }
}

pub struct TokenBridgeInspector {
    program_id: Pubkey,
    token_name: String,
    token_symbol: String,
}

impl TokenBridgeInspector {
    pub fn new(program_id: Pubkey, token_name: String, token_symbol: String) -> Self {
        Self {
            program_id,
            token_name,
            token_symbol,
        }
    }
}

impl Inspector for TokenBridgeInspector {
    fn program_id(&self) -> Pubkey {
        self.program_id
    }

    // pub struct HyperlaneMessage {
    //     /// 1   Hyperlane version number
    //     pub version: u8,
    //     /// 4   Message nonce
    //     pub nonce: u32,
    //     /// 4   Origin domain ID
    //     pub origin: u32,
    //     /// 32  Address in origin convention
    //     pub sender: H256,
    //     /// 4   Destination domain ID
    //     pub destination: u32,
    //     /// 32  Address in destination convention
    //     pub recipient: H256,
    //     /// 0+  Message contents
    //     pub body: Vec<u8>,
    // }
    fn inspect_impl(
        &self,
        payer: &Pubkey,
        message: &HyperlaneMessage
    ) -> Result<Inspection, Error> {
        let mut token_message_reader = std::io::Cursor::new(&message.body);
        let token_message = token_contract::TokenMessage::read_from(&mut token_message_reader)
            .map_err(|_err| Error::InvalidMessageBody)?;
        let (erc20_account, _erc20_bump) = Pubkey::find_program_address(
            hyperlane_token_erc20_pda_seeds!(self.token_name, self.token_symbol),
            &self.program_id,
        );
        let (mint_account, _mint_bump) = Pubkey::find_program_address(
            hyperlane_token_mint_pda_seeds!(self.token_name, self.token_symbol),
            &self.program_id,
        );
        let recipient_wallet_account = Pubkey::new_from_array(token_message.recipient().into());
        let recipient_associated_token_account =
            solana::get_associated_token_address_with_program_id(
                &recipient_wallet_account,
                &mint_account,
                &solana::SPL_TOKEN_2022_ID,
            );
        // spl_noop.so
        //     GpiNbGLpyroc8dFKPhK55eQhhvWn3XUaXJFp5fk5aXUs
        // spl_token.so
        //     GEDyaRBxUxCnA7zU6Uh4KyYnZxQQHUjjdpUzhsK6kZe2
        // spl_token_2022.so
        //     4Rns2H5bzBkNX7BQSj52pbuwokA4BLrNN1mo1FvEDAFf
        // spl_associated_token_account.so
        //     J7CTyNrJn3vnsJfKkVWFXHyP8Wjj8RU9w1GNfZa1d2hH
        // hyperlane_sealevel_token.so
        //     3MzUPjP5LEkiHH82nEAe28Xtz9ztuMqWc8UmuKxrpVQH
        // hyperlane_sealevel_mailbox.so
        //     692KZJaoe2KRcD6uhCQDLLXnLNA5ZLnfvdqjE4aX9iu1
        // hyperlane_sealevel_recipient_echo.so
        //     FZ8hyduJy4GQAfBu9zEiuQtk429Gjc6inwHgEW5MvsEm
        // hyperlane_sealevel_ism_rubber_stamp.so
        //     F6dVnLFioQ8hKszqPsmjWPwHn2dJfebgMfztWrzL548V
        //
        // Accounts for token contract transfer_from_remote()
        //
        // AccountMeta {
        //     pubkey: 11111111111111111111111111111111,
        //     is_signer: false,
        //     is_writable: false,
        // },
        // AccountMeta {
        //     pubkey: 4Rns2H5bzBkNX7BQSj52pbuwokA4BLrNN1mo1FvEDAFf,
        //     is_signer: false,
        //     is_writable: false,
        // },
        // AccountMeta {
        //     pubkey: J7CTyNrJn3vnsJfKkVWFXHyP8Wjj8RU9w1GNfZa1d2hH,
        //     is_signer: false,
        //     is_writable: false,
        // },
        // AccountMeta {
        //     pubkey: 6JcBS4S8P8PdL84yoHYd2WpNhTxYFmRChxHMhFwHZULH,
        //     is_signer: true,
        //     is_writable: true,
        // },
        // AccountMeta {
        //     pubkey: APd85nrgWTTZdaaZwomzZhDoRdz5w5HETGQ2Vfu29AdA,
        //     is_signer: false,
        //     is_writable: false,
        // },
        // AccountMeta {
        //     pubkey: 9mZNZbYS6AKqhc28jWw8pqwyhKK5mRSTNxv2A4ywee4P,
        //     is_signer: false,
        //     is_writable: true,
        // },
        // AccountMeta {
        //     pubkey: 6JcBS4S8P8PdL84yoHYd2WpNhTxYFmRChxHMhFwHZULH,
        //     is_signer: false,
        //     is_writable: true,
        // },
        // AccountMeta {
        //     pubkey: HKLeaDnBs4gu2TX7C8T2Z5NnTh6aKyMEp9UZ6kZYizjs,
        //     is_signer: false,
        //     is_writable: true,
        // },
        let mut accounts = vec![
            AccountMeta::new_readonly(*solana::SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(*solana::SPL_NOOP_ID, false),
            AccountMeta::new_readonly(*solana::SPL_TOKEN_2022_ID, false),
            AccountMeta::new_readonly(*solana::SPL_ASSOCIATED_TOKEN_ACCOUNT_ID, false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(erc20_account, false),
            AccountMeta::new(mint_account, false),
            AccountMeta::new(recipient_wallet_account, false),
            AccountMeta::new(recipient_associated_token_account, false),
        ];

        error!("token_message={:#?}", token_message); // FIXME trace or debug

        Ok(Inspection {
            accounts,
        })
    }
}
