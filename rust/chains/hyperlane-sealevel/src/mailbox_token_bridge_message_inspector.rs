#![allow(warnings)] // FIXME remove

use hyperlane_core::{Decode as _, HyperlaneMessage, H256, U256};
use tracing::error;

use crate::mailbox_message_inspector::{Error, Inspection, Inspector};
use crate::solana::{instruction::AccountMeta, pubkey::Pubkey};
use crate::{
    hyperlane_token_erc20_pda_seeds, hyperlane_token_mint_pda_seeds,
    hyperlane_token_native_collateral_pda_seeds, hyperlane_token_pda_seeds,
};

// FIXME import from solana libs once test deployment fixed. Might also need to fix dependency
// conflicts?
mod solana {
    use std::str::FromStr as _;

    use crate::solana::pubkey::Pubkey;

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
    use hyperlane_core::{Decode, Encode, HyperlaneProtocolError, H256, U256};

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

    #[macro_export]
    macro_rules! hyperlane_token_pda_seeds {
        () => {{
            &[b"hyperlane_token", b"-", b"storage"]
        }};

        ($bump_seed:expr) => {{
            &[b"hyperlane_token", b"-", b"storage", &[$bump_seed]]
        }};
    }

    #[macro_export]
    macro_rules! hyperlane_token_native_collateral_pda_seeds {
        () => {{
            &[b"hyperlane_token", b"-", b"native_token_collateral"]
        }};

        ($bump_seed:expr) => {{
            &[
                b"hyperlane_token",
                b"-",
                b"native_token_collateral",
                &[$bump_seed],
            ]
        }};
    }

    // FIXME this aint gonna work as is. We need to know the asset being sent since we're not using
    // separate recipient contracts for each.
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

        pub fn amount(&self) -> U256 {
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
    native_token_name: String,
    native_token_symbol: String,
    // TODO hold a vec/map of erc20 token infos in order to support more than one wrapped token
    erc20_token_name: String,
    erc20_token_symbol: String,
}

impl TokenBridgeInspector {
    pub fn new(
        program_id: Pubkey,
        native_token_name: String,
        native_token_symbol: String,
        erc20_token_name: String,
        erc20_token_symbol: String,
    ) -> Self {
        Self {
            program_id,
            native_token_name,
            native_token_symbol,
            erc20_token_name,
            erc20_token_symbol,
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
        message: &HyperlaneMessage,
    ) -> Result<Inspection, Error> {
        // TODO probably should verify that hyperlane message version is correct.
        let mut token_message_reader = std::io::Cursor::new(&message.body);
        let token_message = token_contract::TokenMessage::read_from(&mut token_message_reader)
            .map_err(|_err| Error::InvalidMessageBody)?;
        error!("token_message={:#?}", token_message); // FIXME trace or debug

        let recipient_wallet_account = Pubkey::new_from_array(token_message.recipient().into());
        let (token_account, _token_bump) =
            Pubkey::find_program_address(hyperlane_token_pda_seeds!(), &self.program_id);

        // FIXME we need the token message to contain asset name & symbol in order to determine
        // since solana smart contract program accounts are decoupled from data storage accounts.
        // let xfer_is_native = false;
        let xfer_is_native = true;
        // Accounts:
        // 1. mailbox_authority (added prior to CPI by mailbox program)
        // 2. system_program
        // 3. spl_noop
        // 4. hyperlane_token storage
        // 5. recipient wallet address
        // 6. payer
        // For wrapped tokens:
        //     7. spl_token_2022
        //     8. spl_associated_token_account
        //     9. hyperlane_token_erc20
        //     10. hyperlane_token_mint
        //     11. recipient associated token account
        // For native token:
        //     7. native_token_collateral
        let mut accounts = vec![
            AccountMeta::new_readonly(*solana::SYSTEM_PROGRAM_ID, false),
            AccountMeta::new_readonly(*solana::SPL_NOOP_ID, false),
            AccountMeta::new(token_account, false),
            AccountMeta::new(recipient_wallet_account, false),
            AccountMeta::new(*payer, true),
        ];
        if xfer_is_native {
            let (native_collateral_account, _native_collateral_bump) = Pubkey::find_program_address(
                hyperlane_token_native_collateral_pda_seeds!(),
                &self.program_id,
            );
            accounts.extend([AccountMeta::new(native_collateral_account, false)]);
        } else {
            let (erc20_account, _erc20_bump) = Pubkey::find_program_address(
                hyperlane_token_erc20_pda_seeds!(self.erc20_token_name, self.erc20_token_symbol),
                &self.program_id,
            );
            let (mint_account, _mint_bump) = Pubkey::find_program_address(
                hyperlane_token_mint_pda_seeds!(self.erc20_token_name, self.erc20_token_symbol),
                &self.program_id,
            );
            let recipient_associated_token_account =
                solana::get_associated_token_address_with_program_id(
                    &recipient_wallet_account,
                    &mint_account,
                    &solana::SPL_TOKEN_2022_ID,
                );
            accounts.extend([
                AccountMeta::new_readonly(*solana::SPL_TOKEN_2022_ID, false),
                AccountMeta::new_readonly(*solana::SPL_ASSOCIATED_TOKEN_ACCOUNT_ID, false),
                AccountMeta::new_readonly(erc20_account, false),
                AccountMeta::new(mint_account, false),
                AccountMeta::new(recipient_associated_token_account, false),
            ]);
        }

        Ok(Inspection { accounts })
    }
}
