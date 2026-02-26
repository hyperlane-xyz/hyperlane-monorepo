//! Accounts for the Hyperlane token program.

use access_control::AccessControl;
use account_utils::{AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{H256, U256};
use hyperlane_sealevel_connection_client::{
    gas_router::{GasRouterConfig, HyperlaneGasRouter},
    router::{HyperlaneRouter, RemoteRouterConfig},
    HyperlaneConnectionClient, HyperlaneConnectionClientRecipient, HyperlaneConnectionClientSetter,
    HyperlaneConnectionClientSetterAccessControl,
};
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};
use std::{cmp::Ordering, collections::HashMap, fmt::Debug};

use crate::hyperlane_token_pda_seeds;

/// Fee configuration for a warp route.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Clone)]
pub struct FeeConfig {
    /// The fee program ID.
    pub fee_program: Pubkey,
    /// The top-level fee account PDA (owned by fee_program).
    pub fee_account: Pubkey,
}

/// HyperlaneToken account data.
pub type HyperlaneTokenAccount<T> = AccountData<HyperlaneToken<T>>;

/// A PDA account containing the data for a Hyperlane token
/// and any plugin-specific data.
///
/// Manual BorshDeserialize is implemented for backward compatibility:
/// existing accounts without fee_config will deserialize with fee_config = None.
#[derive(BorshSerialize, Debug, PartialEq, Default)]
pub struct HyperlaneToken<T> {
    /// The bump seed for this PDA.
    pub bump: u8,
    /// The address of the mailbox contract.
    pub mailbox: Pubkey,
    /// The Mailbox process authority specific to this program as the recipient.
    pub mailbox_process_authority: Pubkey,
    /// The dispatch authority PDA's bump seed.
    pub dispatch_authority_bump: u8,
    /// The decimals of the local token.
    pub decimals: u8,
    /// The decimals of the remote token.
    pub remote_decimals: u8,
    /// Access control owner.
    pub owner: Option<Pubkey>,
    /// The interchain security module.
    pub interchain_security_module: Option<Pubkey>,
    /// (IGP Program, IGP account).
    pub interchain_gas_paymaster: Option<(Pubkey, InterchainGasPaymasterType)>,
    /// Destination gas amounts.
    pub destination_gas: HashMap<u32, u64>,
    /// Remote routers.
    pub remote_routers: HashMap<u32, H256>,
    /// Plugin-specific data.
    pub plugin_data: T,
    /// Fee configuration. None for legacy accounts or when fees are not configured.
    pub fee_config: Option<FeeConfig>,
}

impl<T: BorshDeserialize> BorshDeserialize for HyperlaneToken<T> {
    fn deserialize_reader<R: std::io::Read>(reader: &mut R) -> std::io::Result<Self> {
        let bump = u8::deserialize_reader(reader)?;
        let mailbox = Pubkey::deserialize_reader(reader)?;
        let mailbox_process_authority = Pubkey::deserialize_reader(reader)?;
        let dispatch_authority_bump = u8::deserialize_reader(reader)?;
        let decimals = u8::deserialize_reader(reader)?;
        let remote_decimals = u8::deserialize_reader(reader)?;
        let owner = Option::<Pubkey>::deserialize_reader(reader)?;
        let interchain_security_module = Option::<Pubkey>::deserialize_reader(reader)?;
        let interchain_gas_paymaster =
            Option::<(Pubkey, InterchainGasPaymasterType)>::deserialize_reader(reader)?;
        let destination_gas = HashMap::<u32, u64>::deserialize_reader(reader)?;
        let remote_routers = HashMap::<u32, H256>::deserialize_reader(reader)?;
        let plugin_data = T::deserialize_reader(reader)?;

        // Backward compatibility: if no more data, fee_config is None.
        // Peek to check if there's remaining data.
        let mut peek_buf = [0u8; 1];
        let fee_config = match reader.read(&mut peek_buf) {
            Ok(0) => None, // EOF — legacy account
            Ok(_) => {
                // We read one byte. If it's 0, that's Option::None.
                // If it's 1, that's Option::Some — read the FeeConfig.
                if peek_buf[0] == 0 {
                    None
                } else {
                    Some(FeeConfig::deserialize_reader(reader)?)
                }
            }
            Err(e) => return Err(e),
        };

        Ok(Self {
            bump,
            mailbox,
            mailbox_process_authority,
            dispatch_authority_bump,
            decimals,
            remote_decimals,
            owner,
            interchain_security_module,
            interchain_gas_paymaster,
            destination_gas,
            remote_routers,
            plugin_data,
            fee_config,
        })
    }
}

impl<T> HyperlaneToken<T>
where
    T: BorshSerialize + BorshDeserialize + Default + Debug,
{
    /// Deserializes the data from the provided `token_account_info` and returns it.
    /// Returns an Err if the provided `token_account_info` is not the canonical HyperlaneToken PDA for this program.
    pub fn verify_account_and_fetch_inner(
        program_id: &Pubkey,
        token_account_info: &AccountInfo<'_>,
    ) -> Result<Self, ProgramError> {
        let token =
            HyperlaneTokenAccount::fetch(&mut &token_account_info.data.borrow()[..])?.into_inner();
        let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
        let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
        if token_account_info.key != &expected_token_key {
            return Err(ProgramError::InvalidArgument);
        }
        if token_account_info.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        Ok(*token)
    }

    /// Converts a local token amount to a remote token amount, accounting for decimals and types.
    pub fn local_amount_to_remote_amount(&self, amount: u64) -> Result<U256, ProgramError> {
        convert_decimals(amount.into(), self.decimals, self.remote_decimals)
            .ok_or(ProgramError::InvalidArgument)
    }

    /// Converts a remote token amount to a local token amount, accounting for decimals and types.
    pub fn remote_amount_to_local_amount(&self, amount: U256) -> Result<u64, ProgramError> {
        let amount = convert_decimals(amount, self.remote_decimals, self.decimals)
            .ok_or(ProgramError::InvalidArgument)?
            .as_u64();
        Ok(amount)
    }
}

impl<T> SizedData for HyperlaneToken<T>
where
    T: SizedData,
{
    fn size(&self) -> usize {
        // std::mem::size_of is used for primitive types, which are guaranteed to
        // have consistent sizes across all platforms (https://doc.rust-lang.org/std/mem/fn.size_of.html).
        // For extra safety, we don't use std::mem::size_of for non-primitive types.

        // bump
        std::mem::size_of::<u8>() +
        // mailbox
        32 +
        // mailbox_process_authority
        32 +
        // dispatch_authority_bump
        std::mem::size_of::<u8>() +
        // decimals
        std::mem::size_of::<u8>() +
        // remote_decimals
        std::mem::size_of::<u8>() +
        // owner
        1 + 32 +
        // interchain_security_module
        1 + 32 +
        // interchain_gas_paymaster
        1 + 32 + 1 + 32 +
        // destination_gas length
        std::mem::size_of::<u32>() +
        // destination_gas keys & values
        (self.destination_gas.len() * (std::mem::size_of::<u32>() + std::mem::size_of::<u64>())) +
        // remote_routers length
        std::mem::size_of::<u32>() +
        // remote_routers keys & values
        (self.remote_routers.len() * (std::mem::size_of::<u32>() + 32)) +
        // plugin_data
        self.plugin_data.size() +
        // fee_config: Option<FeeConfig>
        // 1 byte for Option discriminant + if Some: 32 + 32 = 64
        1 + if self.fee_config.is_some() { 32 + 32 } else { 0 }
    }
}

impl<T> AccessControl for HyperlaneToken<T> {
    fn owner(&self) -> Option<&Pubkey> {
        self.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.owner = new_owner;
        Ok(())
    }
}

impl<T> HyperlaneConnectionClient for HyperlaneToken<T> {
    fn mailbox(&self) -> &Pubkey {
        &self.mailbox
    }

    fn interchain_gas_paymaster(&self) -> Option<&(Pubkey, InterchainGasPaymasterType)> {
        self.interchain_gas_paymaster.as_ref()
    }

    fn interchain_security_module(&self) -> Option<&Pubkey> {
        self.interchain_security_module.as_ref()
    }
}

impl<T> HyperlaneConnectionClientSetter for HyperlaneToken<T> {
    fn set_mailbox(&mut self, new_mailbox: Pubkey) {
        self.mailbox = new_mailbox;
    }

    fn set_interchain_gas_paymaster(
        &mut self,
        new_igp: Option<(Pubkey, InterchainGasPaymasterType)>,
    ) {
        self.interchain_gas_paymaster = new_igp;
    }

    fn set_interchain_security_module(&mut self, new_ism: Option<Pubkey>) {
        self.interchain_security_module = new_ism;
    }
}

impl<T> HyperlaneConnectionClientSetterAccessControl for HyperlaneToken<T> {}

impl<T> HyperlaneConnectionClientRecipient for HyperlaneToken<T> {
    fn mailbox_process_authority(&self) -> &Pubkey {
        &self.mailbox_process_authority
    }
}

impl<T> HyperlaneRouter for HyperlaneToken<T> {
    fn router(&self, origin: u32) -> Option<&H256> {
        self.remote_routers.router(origin)
    }

    fn enroll_remote_router(&mut self, config: RemoteRouterConfig) {
        self.remote_routers.enroll_remote_router(config);
    }
}

impl<T> HyperlaneGasRouter for HyperlaneToken<T> {
    fn destination_gas(&self, destination: u32) -> Option<u64> {
        self.destination_gas.destination_gas(destination)
    }

    fn set_destination_gas(&mut self, config: GasRouterConfig) {
        self.destination_gas.set_destination_gas(config);
    }
}

/// Converts an amount from one decimal representation to another.
pub fn convert_decimals(amount: U256, from_decimals: u8, to_decimals: u8) -> Option<U256> {
    match from_decimals.cmp(&to_decimals) {
        Ordering::Greater => {
            let divisor = U256::from(10u64).checked_pow(U256::from(from_decimals - to_decimals));
            divisor.and_then(|d| amount.checked_div(d))
        }
        Ordering::Less => {
            let multiplier = U256::from(10u64).checked_pow(U256::from(to_decimals - from_decimals));
            multiplier.and_then(|m| amount.checked_mul(m))
        }
        Ordering::Equal => Some(amount),
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use borsh::BorshSerialize;

    #[test]
    fn test_convert_decimals() {
        // No decimal difference
        assert_eq!(
            convert_decimals(U256::from(100), 2, 2),
            Some(U256::from(100))
        );

        // Low decimals -> High decimals
        assert_eq!(
            convert_decimals(U256::from(100), 2, 5),
            Some(U256::from(100000))
        );

        // High decimals -> Low decimals
        assert_eq!(
            convert_decimals(U256::from(100000), 5, 2),
            Some(U256::from(100))
        );

        // High decimals -> Low decimals, with loss of precision
        assert_eq!(
            convert_decimals(U256::from(100001), 5, 2),
            Some(U256::from(100))
        );
    }

    #[test]
    fn test_local_amount_to_remote_amount() {
        let token: HyperlaneToken<()> = HyperlaneToken {
            decimals: 9,
            remote_decimals: 18,
            ..HyperlaneToken::<()>::default()
        };

        assert_eq!(
            token.local_amount_to_remote_amount(1_000_000_000),
            Ok(U256::from(10).pow(U256::from(18)))
        );

        // Try an overflow
        let token: HyperlaneToken<()> = HyperlaneToken {
            decimals: 9,
            remote_decimals: 200,
            ..HyperlaneToken::<()>::default()
        };

        assert_eq!(
            token.local_amount_to_remote_amount(1_000_000_000),
            Err(ProgramError::InvalidArgument)
        );

        // Try a loss of precision
        let token: HyperlaneToken<()> = HyperlaneToken {
            decimals: 9,
            remote_decimals: 5,
            ..HyperlaneToken::<()>::default()
        };

        assert_eq!(token.local_amount_to_remote_amount(100), Ok(U256::zero()));
    }

    #[test]
    fn test_remote_amount_to_local_amount() {
        let token: HyperlaneToken<()> = HyperlaneToken {
            decimals: 9,
            remote_decimals: 18,
            ..HyperlaneToken::<()>::default()
        };

        assert_eq!(
            token.remote_amount_to_local_amount(U256::from(10u64).pow(U256::from(18u64))),
            Ok(10u64.pow(9u32))
        );

        // Try an overflow
        let token: HyperlaneToken<()> = HyperlaneToken {
            decimals: 200,
            remote_decimals: 9,
            ..HyperlaneToken::<()>::default()
        };

        assert_eq!(
            token.remote_amount_to_local_amount(1_000_000_000u64.into()),
            Err(ProgramError::InvalidArgument)
        );

        // Try a loss of precision
        let token: HyperlaneToken<()> = HyperlaneToken {
            decimals: 5,
            remote_decimals: 9,
            ..HyperlaneToken::<()>::default()
        };

        assert_eq!(token.remote_amount_to_local_amount(100u64.into()), Ok(0));
    }

    #[test]
    fn test_hyperlane_token_size() {
        #[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
        struct Foo {
            bar: u32,
        }

        impl SizedData for Foo {
            fn size(&self) -> usize {
                std::mem::size_of::<u32>()
            }
        }

        let hyperlane_token_foo = HyperlaneToken::<Foo> {
            bump: 1,
            mailbox: Pubkey::new_unique(),
            mailbox_process_authority: Pubkey::new_unique(),
            dispatch_authority_bump: 2,
            decimals: 3,
            remote_decimals: 4,
            owner: Some(Pubkey::new_unique()),
            interchain_security_module: Some(Pubkey::new_unique()),
            interchain_gas_paymaster: Some((
                Pubkey::new_unique(),
                InterchainGasPaymasterType::Igp(Pubkey::new_unique()),
            )),
            destination_gas: HashMap::from([(1000, 200000), (200, 400000)]),
            remote_routers: HashMap::from([(1000, H256::random()), (200, H256::random())]),
            plugin_data: Foo { bar: 69 },
            fee_config: None,
        };
        let serialized = borsh::to_vec(&hyperlane_token_foo).unwrap();

        assert_eq!(serialized.len(), hyperlane_token_foo.size());

        // Also test with fee_config = Some
        let hyperlane_token_with_fee = HyperlaneToken::<Foo> {
            fee_config: Some(FeeConfig {
                fee_program: Pubkey::new_unique(),
                fee_account: Pubkey::new_unique(),
            }),
            ..hyperlane_token_foo
        };
        let serialized = borsh::to_vec(&hyperlane_token_with_fee).unwrap();
        assert_eq!(serialized.len(), hyperlane_token_with_fee.size());
    }

    #[test]
    fn test_backward_compat_deserialization() {
        // Simulate a legacy account without fee_config
        let legacy_token = HyperlaneToken::<()> {
            bump: 1,
            mailbox: Pubkey::new_unique(),
            mailbox_process_authority: Pubkey::new_unique(),
            dispatch_authority_bump: 2,
            decimals: 9,
            remote_decimals: 18,
            owner: None,
            interchain_security_module: None,
            interchain_gas_paymaster: None,
            destination_gas: HashMap::new(),
            remote_routers: HashMap::new(),
            plugin_data: (),
            fee_config: None,
        };

        // Serialize without fee_config (simulate legacy format by serializing
        // all fields except fee_config manually)
        let mut legacy_bytes = Vec::new();
        legacy_token.bump.serialize(&mut legacy_bytes).unwrap();
        legacy_token.mailbox.serialize(&mut legacy_bytes).unwrap();
        legacy_token
            .mailbox_process_authority
            .serialize(&mut legacy_bytes)
            .unwrap();
        legacy_token
            .dispatch_authority_bump
            .serialize(&mut legacy_bytes)
            .unwrap();
        legacy_token.decimals.serialize(&mut legacy_bytes).unwrap();
        legacy_token
            .remote_decimals
            .serialize(&mut legacy_bytes)
            .unwrap();
        legacy_token.owner.serialize(&mut legacy_bytes).unwrap();
        legacy_token
            .interchain_security_module
            .serialize(&mut legacy_bytes)
            .unwrap();
        legacy_token
            .interchain_gas_paymaster
            .serialize(&mut legacy_bytes)
            .unwrap();
        legacy_token
            .destination_gas
            .serialize(&mut legacy_bytes)
            .unwrap();
        legacy_token
            .remote_routers
            .serialize(&mut legacy_bytes)
            .unwrap();
        legacy_token
            .plugin_data
            .serialize(&mut legacy_bytes)
            .unwrap();
        // No fee_config serialized — simulates legacy account

        let deserialized: HyperlaneToken<()> =
            BorshDeserialize::try_from_slice(&legacy_bytes).unwrap();
        assert_eq!(deserialized.fee_config, None);
        assert_eq!(deserialized.bump, 1);
        assert_eq!(deserialized.decimals, 9);
    }
}
