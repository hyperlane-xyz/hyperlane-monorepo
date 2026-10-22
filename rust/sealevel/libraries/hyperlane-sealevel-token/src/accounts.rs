//! Accounts for the Hyperlane token program.

use access_control::AccessControl;
use account_utils::{
    read_map_value, AccountData, DiscriminatorData, OptionalDiscriminatedData, SizedData,
};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{H256, U256};
use hyperlane_sealevel_connection_client::{
    gas_router::{GasRouterConfig, HyperlaneGasRouter},
    router::{HyperlaneRouter, RemoteRouterConfig},
    HyperlaneConnectionClient, HyperlaneConnectionClientRecipient, HyperlaneConnectionClientSetter,
    HyperlaneConnectionClientSetterAccessControl,
};
use hyperlane_sealevel_igp::accounts::{checked_convert_decimals, InterchainGasPaymasterType};
use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};
use std::{collections::HashMap, fmt::Debug, ops::Deref};

use crate::hyperlane_token_pda_seeds;

/// HyperlaneToken account data.
pub type HyperlaneTokenAccount<T> = AccountData<HyperlaneToken<T>>;

/// Configuration for the optional warp fee.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, PartialEq)]
pub struct FeeConfig {
    /// The fee program to CPI into for QuoteFee.
    pub fee_program: Pubkey,
    /// The fee account PDA owned by the fee program.
    pub fee_account: Pubkey,
}

impl DiscriminatorData for FeeConfig {
    const DISCRIMINATOR: [u8; 8] = *b"TOKFEEV1";
}

impl SizedData for FeeConfig {
    fn size(&self) -> usize {
        // fee_program + fee_account
        32 + 32
    }
}

/// A PDA account containing the data for a Hyperlane token
/// and any plugin-specific data.
#[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq, Default)]
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
    /// Optional warp fee configuration. Must be the last field for
    /// backward-compatible deserialization.
    pub fee_config: OptionalDiscriminatedData<FeeConfig>,
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
            .ok_or(ProgramError::InvalidArgument)?;
        u64::try_from(amount).map_err(|_| ProgramError::ArithmeticOverflow)
    }
}

/// A `HyperlaneToken` read for a single domain: `destination_gas` and
/// `remote_routers` hold only that domain's entry, if any. All other fields
/// are as stored.
///
/// `HyperlaneTokenAccount::fetch` builds both maps, which costs ~420 CU per
/// entry on SBF; instructions that read one domain (or none) use this.
/// The view only derefs to the token, so it can't be stored back and
/// truncate the maps.
#[derive(Debug, PartialEq)]
pub struct HyperlaneTokenDomainView<T>(Box<HyperlaneToken<T>>);

impl<T> Deref for HyperlaneTokenDomainView<T> {
    type Target = HyperlaneToken<T>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T> HyperlaneTokenDomainView<T>
where
    T: BorshDeserialize + Default,
{
    /// Parses token account data like `HyperlaneTokenAccount::fetch`, with
    /// the same validation and errors, keeping only `domain`'s map entries.
    /// `None` keeps no entries.
    pub fn fetch(data: &[u8], domain: Option<u32>) -> Result<Self, ProgramError> {
        let buf = &mut &data[..];
        if buf.is_empty() {
            return Ok(Self(Box::default()));
        }
        // Account data is zero initialized.
        let initialized = bool::deserialize(buf)?;
        if !initialized {
            return Ok(Self(Box::default()));
        }
        Self::read_boxed(buf, domain)
            .map(Self)
            .map_err(|_| ProgramError::BorshIoError)
    }

    /// Reads the fields of `HyperlaneToken<T>` in the order the derived
    /// `BorshDeserialize` does. Not inlined so the large stack frame is
    /// released after return, as in `AccountData::fetch`.
    #[inline(never)]
    fn read_boxed(
        reader: &mut &[u8],
        domain: Option<u32>,
    ) -> std::io::Result<Box<HyperlaneToken<T>>> {
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
        let destination_gas = read_map_value::<u32, u64, _>(reader, domain)?;
        let remote_routers = read_map_value::<u32, H256, _>(reader, domain)?;
        let plugin_data = T::deserialize_reader(reader)?;
        let fee_config = OptionalDiscriminatedData::deserialize_reader(reader)?;
        Ok(Box::new(HyperlaneToken {
            bump,
            mailbox,
            mailbox_process_authority,
            dispatch_authority_bump,
            decimals,
            remote_decimals,
            owner,
            interchain_security_module,
            interchain_gas_paymaster,
            destination_gas: domain.zip(destination_gas).into_iter().collect(),
            remote_routers: domain.zip(remote_routers).into_iter().collect(),
            plugin_data,
            fee_config,
        }))
    }

    /// Like `HyperlaneToken::verify_account_and_fetch_inner`, reading only
    /// `domain`'s map entries.
    pub fn verify_account_and_fetch(
        program_id: &Pubkey,
        token_account_info: &AccountInfo<'_>,
        domain: Option<u32>,
    ) -> Result<Self, ProgramError> {
        let token = Self::fetch(&token_account_info.data.borrow(), domain)?;
        let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
        let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
        if token_account_info.key != &expected_token_key {
            return Err(ProgramError::InvalidArgument);
        }
        if token_account_info.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        Ok(token)
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
        // fee_config: 0 when None, DISCRIMINATOR (8) + 32 + 32 when Some.
        self.fee_config.size()
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
    checked_convert_decimals(amount, from_decimals, to_decimals)
}

#[cfg(test)]
mod test {
    use super::*;

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
            fee_config: None.into(),
        };
        let serialized = borsh::to_vec(&hyperlane_token_foo).unwrap();

        assert_eq!(serialized.len(), hyperlane_token_foo.size());
    }

    #[test]
    fn test_hyperlane_token_size_with_fee_config() {
        #[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
        struct Foo {
            bar: u32,
        }

        impl SizedData for Foo {
            fn size(&self) -> usize {
                std::mem::size_of::<u32>()
            }
        }

        let token = HyperlaneToken::<Foo> {
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
            destination_gas: HashMap::from([(1000, 200000)]),
            remote_routers: HashMap::from([(1000, H256::random())]),
            plugin_data: Foo { bar: 42 },
            fee_config: Some(FeeConfig {
                fee_program: Pubkey::new_unique(),
                fee_account: Pubkey::new_unique(),
            })
            .into(),
        };
        let serialized = borsh::to_vec(&token).unwrap();
        assert_eq!(serialized.len(), token.size());
    }

    #[test]
    fn test_backward_compat_deserialize_without_fee_config() {
        // Serializing with fee_config: None omits the trailing field entirely,
        // producing the same layout as a pre-upgrade account. Verify EOF → None.
        let token = HyperlaneToken::<()> {
            bump: 1,
            decimals: 9,
            remote_decimals: 18,
            fee_config: None.into(),
            ..HyperlaneToken::<()>::default()
        };
        let serialized = borsh::to_vec(&token).unwrap();

        let mut reader = std::io::Cursor::new(&serialized);
        let deserialized = HyperlaneToken::<()>::deserialize_reader(&mut reader).unwrap();
        assert_eq!(deserialized.fee_config, None);
        assert_eq!(deserialized.bump, 1);
        assert_eq!(deserialized.decimals, 9);
        assert_eq!(deserialized.remote_decimals, 18);
    }

    #[test]
    fn test_deserialize_with_fee_config() {
        let token = HyperlaneToken::<()> {
            bump: 1,
            decimals: 9,
            remote_decimals: 18,
            fee_config: Some(FeeConfig {
                fee_program: Pubkey::new_unique(),
                fee_account: Pubkey::new_unique(),
            })
            .into(),
            ..HyperlaneToken::<()>::default()
        };

        let serialized = borsh::to_vec(&token).unwrap();
        let mut reader = std::io::Cursor::new(&serialized);
        let deserialized = HyperlaneToken::<()>::deserialize_reader(&mut reader).unwrap();

        assert_eq!(deserialized, token);
    }

    // HLSVM-2026Q2-010 regression guards. `overlay_shrunk` reproduces a pre-#8698
    // store after a router removal (freed tail left non-zero). Tabled over the
    // three real plugin sizes since plugin_data sits between the map and fee_config.

    /// Fixed-size stand-in for a concrete plugin; N is a real plugin's size
    /// (Native=1, Synthetic=34, Collateral=98).
    #[derive(BorshSerialize, BorshDeserialize, Debug, PartialEq)]
    struct FixedPlugin<const N: usize> {
        data: [u8; N],
    }

    impl<const N: usize> Default for FixedPlugin<N> {
        fn default() -> Self {
            Self { data: [0u8; N] }
        }
    }

    impl<const N: usize> SizedData for FixedPlugin<N> {
        fn size(&self) -> usize {
            N
        }
    }

    fn token_with<const N: usize>(
        routers: &[(u32, H256)],
        plugin_byte: u8,
        fee_config: Option<FeeConfig>,
    ) -> HyperlaneToken<FixedPlugin<N>> {
        HyperlaneToken {
            bump: 1,
            decimals: 9,
            remote_decimals: 18,
            remote_routers: routers.iter().copied().collect(),
            plugin_data: FixedPlugin {
                data: [plugin_byte; N],
            },
            fee_config: fee_config.into(),
            ..Default::default()
        }
    }

    fn overlay_shrunk(before: Vec<u8>, keep: Vec<u8>) -> Vec<u8> {
        assert!(keep.len() < before.len());
        let mut buf = before;
        buf[..keep.len()].copy_from_slice(&keep);
        buf
    }

    // Removed router + plugin both filled with the sentinel, so the byte past
    // plugin_data is the sentinel regardless of which field it lands in.

    /// Stale 0x02 tail must not reject the account.
    fn assert_stale_router_tail_rejects<const N: usize>() {
        let keep = borsh::to_vec(&token_with::<N>(&[(0, H256::zero())], 0x02, None)).unwrap();
        let before = borsh::to_vec(&token_with::<N>(
            &[(0, H256::zero()), (0x0202_0202, H256::from([0x02; 32]))],
            0x02,
            None,
        ))
        .unwrap();
        let boundary = keep.len();
        let buf = overlay_shrunk(before, keep);
        assert_eq!(
            buf[boundary], 0x02,
            "N={N}: trigger byte should be the stale 0x02"
        );

        let decoded = HyperlaneToken::<FixedPlugin<N>>::deserialize_reader(&mut &buf[..])
            .unwrap_or_else(|e| {
                panic!("N={N}: stale router tail must not make the token unreadable: {e}")
            });
        assert_eq!(
            decoded.fee_config, None,
            "N={N}: stale bytes must not be read as fee_config",
        );
    }

    /// Stale 0x01 tail must not be misread as Some.
    fn assert_stale_router_tail_not_misread<const N: usize>() {
        let keep = borsh::to_vec(&token_with::<N>(&[(0, H256::zero())], 0x01, None)).unwrap();
        let before = borsh::to_vec(&token_with::<N>(
            &[
                (0, H256::zero()),
                (0x0101_0101, H256::from([0x01; 32])),
                (0x0101_0102, H256::from([0x01; 32])),
            ],
            0x01,
            None,
        ))
        .unwrap();
        let boundary = keep.len();
        let buf = overlay_shrunk(before, keep);
        assert_eq!(
            buf[boundary], 0x01,
            "N={N}: trigger byte should be the stale 0x01"
        );

        let decoded = HyperlaneToken::<FixedPlugin<N>>::deserialize_reader(&mut &buf[..]).unwrap();
        assert_eq!(
            decoded.fee_config, None,
            "N={N}: stale 0x01 tail must not be misread as Some(FeeConfig)",
        );
    }

    /// A genuine fee_config must survive stale router bytes trailing it.
    fn assert_real_fee_config_survives<const N: usize>() {
        let fee_config = FeeConfig {
            fee_program: Pubkey::new_unique(),
            fee_account: Pubkey::new_unique(),
        };
        let keep = borsh::to_vec(&token_with::<N>(
            &[(0, H256::zero())],
            0,
            Some(fee_config.clone()),
        ))
        .unwrap();
        let before = borsh::to_vec(&token_with::<N>(
            &[(0, H256::zero()), (1, H256::from([9u8; 32]))],
            0,
            Some(fee_config.clone()),
        ))
        .unwrap();
        let buf = overlay_shrunk(before, keep);

        let decoded = HyperlaneToken::<FixedPlugin<N>>::deserialize_reader(&mut &buf[..]).unwrap();
        assert_eq!(
            decoded.fee_config,
            Some(fee_config),
            "N={N}: real fee_config must survive a stale remote_routers tail",
        );
    }

    // Per-size tests (Native=1, Synthetic=34, Collateral=98) so each plugin size
    // is validated independently rather than short-circuiting at the first.
    macro_rules! stale_tail_tests {
        ($size:literal => $rejects:ident, $not_misread:ident, $survives:ident) => {
            #[test]
            fn $rejects() {
                assert_stale_router_tail_rejects::<$size>();
            }

            #[test]
            fn $not_misread() {
                assert_stale_router_tail_not_misread::<$size>();
            }

            #[test]
            fn $survives() {
                assert_real_fee_config_survives::<$size>();
            }
        };
    }

    // --- Domain view ---

    /// Small deterministic PRNG (xorshift64) for the view equivalence tests.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }

        fn below(&mut self, n: u64) -> u64 {
            self.next() % n
        }

        fn coin(&mut self) -> bool {
            self.below(2) == 1
        }

        fn bytes<const N: usize>(&mut self) -> [u8; N] {
            core::array::from_fn(|_| self.next() as u8)
        }

        fn pubkey(&mut self) -> Pubkey {
            Pubkey::new_from_array(self.bytes())
        }
    }

    /// Domains are drawn from a small range so lookups hit and miss.
    const VIEW_TEST_DOMAINS: u64 = 64;

    fn random_token<const N: usize>(rng: &mut Rng) -> HyperlaneToken<FixedPlugin<N>> {
        let interchain_gas_paymaster = match rng.below(3) {
            0 => None,
            1 => Some((rng.pubkey(), InterchainGasPaymasterType::Igp(rng.pubkey()))),
            _ => Some((
                rng.pubkey(),
                InterchainGasPaymasterType::OverheadIgp(rng.pubkey()),
            )),
        };
        HyperlaneToken {
            bump: rng.next() as u8,
            mailbox: rng.pubkey(),
            mailbox_process_authority: rng.pubkey(),
            dispatch_authority_bump: rng.next() as u8,
            decimals: rng.next() as u8,
            remote_decimals: rng.next() as u8,
            owner: rng.coin().then(|| rng.pubkey()),
            interchain_security_module: rng.coin().then(|| rng.pubkey()),
            interchain_gas_paymaster,
            destination_gas: (0..rng.below(50))
                .map(|_| (rng.below(VIEW_TEST_DOMAINS) as u32, rng.next()))
                .collect(),
            remote_routers: (0..rng.below(50))
                .map(|_| (rng.below(VIEW_TEST_DOMAINS) as u32, H256(rng.bytes())))
                .collect(),
            plugin_data: FixedPlugin { data: rng.bytes() },
            fee_config: rng
                .coin()
                .then(|| FeeConfig {
                    fee_program: rng.pubkey(),
                    fee_account: rng.pubkey(),
                })
                .into(),
        }
    }

    /// Account data variants: as stored, with trailing bytes, truncated,
    /// with a corrupted byte, uninitialized, and empty.
    fn mutations(rng: &mut Rng, stored: Vec<u8>) -> Vec<Vec<u8>> {
        let mut out = vec![stored.clone(), vec![], vec![0], vec![2]];
        let mut padded = stored.clone();
        padded.extend((0..rng.below(80)).map(|_| rng.next() as u8));
        out.push(padded);
        for _ in 0..4 {
            out.push(stored[..rng.below(stored.len() as u64) as usize].to_vec());
            let mut corrupted = stored.clone();
            let i = rng.below(stored.len() as u64) as usize;
            corrupted[i] = rng.next() as u8;
            out.push(corrupted);
        }
        out
    }

    /// Checks `HyperlaneTokenDomainView::fetch` against the full
    /// `HyperlaneTokenAccount::fetch` with the maps cut down to the domain,
    /// for every domain and for `None`.
    fn assert_view_matches_fetch<const N: usize>(data: &[u8]) {
        let domains = (0..VIEW_TEST_DOMAINS as u32).map(Some).chain([None]);
        for domain in domains {
            let expected =
                HyperlaneTokenAccount::<FixedPlugin<N>>::fetch(&mut &data[..]).map(|account| {
                    let mut token = account.into_inner();
                    token.destination_gas.retain(|k, _| Some(*k) == domain);
                    token.remote_routers.retain(|k, _| Some(*k) == domain);
                    *token
                });
            let actual =
                HyperlaneTokenDomainView::<FixedPlugin<N>>::fetch(data, domain).map(|view| *view.0);
            assert_eq!(actual, expected, "N={N} data={data:?} domain={domain:?}");
        }
    }

    fn assert_view_matches_fetch_random<const N: usize>(seed: u64) {
        let mut rng = Rng(seed);
        for _ in 0..100 {
            let token = random_token::<N>(&mut rng);
            let mut stored = vec![1u8];
            stored.extend(borsh::to_vec(&token).unwrap());
            for data in mutations(&mut rng, stored) {
                assert_view_matches_fetch::<N>(&data);
            }
        }
    }

    #[test]
    fn test_domain_view_matches_fetch() {
        assert_view_matches_fetch_random::<1>(0x9e37_79b9_7f4a_7c15);
        assert_view_matches_fetch_random::<34>(0x2545_f491_4f6c_dd1d);
        assert_view_matches_fetch_random::<98>(0xd1b5_4a32_d192_ed03);
    }

    /// Repeated keys (not produced by borsh serialization of a map, but
    /// possible in account data) resolve to the last entry, as in the full
    /// parse.
    #[test]
    fn test_domain_view_repeated_keys_match_fetch() {
        let token = token_with::<34>(&[(5, H256::zero())], 7, None);
        let mut data = vec![1u8];
        data.extend(borsh::to_vec(&token).unwrap());
        // Rebuild the maps by hand with repeated keys.
        let maps_offset = 1 + 1 + 32 + 32 + 1 + 1 + 1 + 1 + 1 + 1;
        let tail = data[maps_offset + 4 + 4 + 36..].to_vec();
        data.truncate(maps_offset);
        data.extend(3u32.to_le_bytes());
        for (domain, gas) in [(5u32, 1u64), (6, 2), (5, 3)] {
            data.extend(domain.to_le_bytes());
            data.extend(gas.to_le_bytes());
        }
        data.extend(3u32.to_le_bytes());
        for (domain, byte) in [(5u32, 1u8), (5, 2), (6, 3)] {
            data.extend(domain.to_le_bytes());
            data.extend([byte; 32]);
        }
        data.extend(tail);
        let view = HyperlaneTokenDomainView::<FixedPlugin<34>>::fetch(&data, Some(5)).unwrap();
        assert_eq!(view.destination_gas, HashMap::from([(5, 3)]));
        assert_eq!(view.remote_routers, HashMap::from([(5, H256([2; 32]))]));
        assert_view_matches_fetch::<34>(&data);
    }

    /// The HLSVM-2026Q2-010 stale-tail layouts parse the same way.
    #[test]
    fn test_domain_view_stale_router_tail_matches_fetch() {
        fn check<const N: usize>() {
            let fee_config = Some(FeeConfig {
                fee_program: Pubkey::new_unique(),
                fee_account: Pubkey::new_unique(),
            });
            for (plugin_byte, fee_config) in [(0x01, None), (0x02, None), (0, fee_config)] {
                let keep = borsh::to_vec(&token_with::<N>(
                    &[(0, H256::zero())],
                    plugin_byte,
                    fee_config.clone(),
                ))
                .unwrap();
                let before = borsh::to_vec(&token_with::<N>(
                    &[
                        (0, H256::zero()),
                        (0x0101_0101, H256::from([plugin_byte; 32])),
                        (0x0101_0102, H256::from([plugin_byte; 32])),
                    ],
                    plugin_byte,
                    fee_config,
                ))
                .unwrap();
                let mut data = vec![1u8];
                data.extend(overlay_shrunk(before, keep));
                assert_view_matches_fetch::<N>(&data);
            }
        }
        check::<1>();
        check::<34>();
        check::<98>();
    }

    stale_tail_tests!(1 =>
        test_token_stale_router_tail_rejects_native,
        test_token_stale_router_tail_not_misread_native,
        test_token_real_fee_config_survives_native);

    stale_tail_tests!(34 =>
        test_token_stale_router_tail_rejects_synthetic,
        test_token_stale_router_tail_not_misread_synthetic,
        test_token_real_fee_config_survives_synthetic);

    stale_tail_tests!(98 =>
        test_token_stale_router_tail_rejects_collateral,
        test_token_stale_router_tail_not_misread_collateral,
        test_token_real_fee_config_survives_collateral);
}
