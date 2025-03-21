use std::{fmt::Display, fmt::Formatter, str::FromStr};

use cynic::impl_scalar;
use fuel_core_client::client::schema::{
    primitives::{HexFormatted, HexString, Tai64Timestamp},
    ConversionError,
};
use fuels::{
    client::{PageDirection, PaginationRequest},
    tx::Receipt as FuelReceipt,
};
use serde::{de::Error, Deserialize, Deserializer, Serialize, Serializer};

use super::generate_receipt;

#[cynic::schema("fuel")]
mod schema {}

// The following macros and conversions are copied from the Fuels Rust SDK
// This allows us to customize the GraphQL schema types and request different
// parameters based on the needs of the Hyperlane Fuel Indexer

macro_rules! fuel_type_scalar {
    ($id:ident, $ft_id:ident) => {
        #[derive(cynic::Scalar, Debug, Clone, Default)]
        pub struct $id(pub HexFormatted<::fuel_core_types::fuel_types::$ft_id>);

        impl FromStr for $id {
            type Err = ConversionError;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                let b = HexFormatted::<::fuel_core_types::fuel_types::$ft_id>::from_str(s)?;
                Ok($id(b))
            }
        }

        impl From<$id> for ::fuel_core_types::fuel_types::$ft_id {
            fn from(s: $id) -> Self {
                ::fuel_core_types::fuel_types::$ft_id::new(s.0 .0.into())
            }
        }

        impl From<::fuel_core_types::fuel_types::$ft_id> for $id {
            fn from(s: ::fuel_core_types::fuel_types::$ft_id) -> Self {
                $id(HexFormatted::<::fuel_core_types::fuel_types::$ft_id>(s))
            }
        }

        impl Display for $id {
            fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
                Display::fmt(&self.0, f)
            }
        }
    };
}

fuel_type_scalar!(Bytes32, Bytes32);
fuel_type_scalar!(Address, Address);
fuel_type_scalar!(BlockId, Bytes32);
fuel_type_scalar!(AssetId, AssetId);
fuel_type_scalar!(BlobId, BlobId);
fuel_type_scalar!(ContractId, ContractId);
fuel_type_scalar!(Salt, Salt);
fuel_type_scalar!(TransactionId, Bytes32);
fuel_type_scalar!(RelayedTransactionId, Bytes32);
fuel_type_scalar!(Signature, Bytes64);
fuel_type_scalar!(Nonce, Nonce);

macro_rules! number_scalar {
    ($i:ident, $t:ty) => {
        #[derive(Debug, Clone, derive_more::Into, derive_more::From, PartialOrd, Eq, PartialEq)]
        pub struct $i(pub $t);
        impl_scalar!($i, schema::$i);

        impl Serialize for $i {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                let s = self.0.to_string();
                serializer.serialize_str(s.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $i {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                let s: String = Deserialize::deserialize(deserializer)?;
                Ok(Self(s.parse().map_err(D::Error::custom)?))
            }
        }
    };
}

impl<T: Into<String>> From<PaginationRequest<T>> for ConnectionArgs {
    fn from(req: PaginationRequest<T>) -> Self {
        match req.direction {
            PageDirection::Forward => Self {
                after: req.cursor.map(Into::into),
                before: None,
                first: Some(req.results),
                last: None,
            },
            PageDirection::Backward => Self {
                after: None,
                before: req.cursor.map(Into::into),
                first: None,
                last: Some(req.results),
            },
        }
    }
}

number_scalar!(U64, u64);
number_scalar!(U32, u32);
number_scalar!(U16, u16);
impl_scalar!(Tai64Timestamp, schema::Tai64Timestamp);
impl_scalar!(HexString, schema::HexString);

/// Generic graphql pagination query args
#[derive(cynic::QueryVariables, Debug, Default)]
pub struct ConnectionArgs {
    /// Skip until cursor (forward pagination)
    pub after: Option<String>,
    /// Skip until cursor (backward pagination)
    pub before: Option<String>,
    /// Retrieve the first n items in order (forward pagination)
    pub first: Option<i32>,
    /// Retrieve the last n items in order (backward pagination).
    /// Can't be used at the same time as `first`.
    pub last: Option<i32>,
}

#[derive(cynic::Enum, Clone, Debug)]
pub enum HeaderVersion {
    V1,
}

#[derive(cynic::Enum, Clone, Copy, Debug)]
pub enum ReceiptType {
    Call,
    Return,
    ReturnData,
    Panic,
    Revert,
    Log,
    LogData,
    Transfer,
    TransferOut,
    ScriptResult,
    MessageOut,
    Mint,
    Burn,
}

#[derive(cynic::QueryFragment, Clone, Debug)]
pub struct Receipt {
    pub param1: Option<U64>,
    pub param2: Option<U64>,
    pub amount: Option<U64>,
    pub asset_id: Option<AssetId>,
    pub gas: Option<U64>,
    pub digest: Option<Bytes32>,
    pub id: Option<ContractId>,
    pub is: Option<U64>,
    pub pc: Option<U64>,
    pub ptr: Option<U64>,
    pub ra: Option<U64>,
    pub rb: Option<U64>,
    pub rc: Option<U64>,
    pub rd: Option<U64>,
    pub reason: Option<U64>,
    pub receipt_type: ReceiptType,
    pub data: Option<HexString>,
    pub to: Option<ContractId>,
    pub to_address: Option<Address>,
    pub val: Option<U64>,
    pub len: Option<U64>,
    pub result: Option<U64>,
    pub gas_used: Option<U64>,
    pub sender: Option<Address>,
    pub recipient: Option<Address>,
    pub nonce: Option<Nonce>,
    pub contract_id: Option<ContractId>,
    pub sub_id: Option<Bytes32>,
}

#[derive(cynic::QueryFragment, Clone, Debug)]
pub struct Header {
    pub height: U32,
}

#[derive(cynic::QueryFragment, Clone, Debug)]
pub struct SuccessStatus {
    pub receipts: Vec<Receipt>,
}

#[allow(clippy::enum_variant_names)]
#[derive(cynic::InlineFragments, Clone, Debug)]
pub enum TransactionStatus {
    SuccessStatus(SuccessStatus),
    #[cynic(fallback)]
    Unknown,
}

#[derive(cynic::QueryFragment, Clone, Debug)]
#[cynic(graphql_type = "Transaction")]
pub struct Transaction {
    pub id: TransactionId,
    pub is_script: bool,
    pub input_contracts: Option<Vec<ContractId>>,
    pub status: Option<TransactionStatus>,
}

impl Transaction {
    pub fn extract_receipts(&self) -> Option<Vec<FuelReceipt>> {
        if let TransactionStatus::SuccessStatus(status) = self.status.clone()? {
            let receipts = status
                .receipts
                .into_iter()
                .filter_map(|receipt| generate_receipt(receipt).ok())
                .collect::<Vec<_>>();
            return Some(receipts);
        }
        None
    }

    pub fn is_valid(&self) -> bool {
        self.status
            .clone()
            .is_some_and(|status| matches!(status, TransactionStatus::SuccessStatus(_)))
            && self.is_script
            && self.input_contracts.is_some()
    }
}

#[derive(cynic::QueryFragment, Clone, Debug)]
#[cynic(graphql_type = "Block")]
pub struct Block {
    pub id: BlockId,
    pub header: Header,
    pub transactions: Vec<Transaction>,
}

#[derive(cynic::QueryFragment, Debug, Clone)]
#[cynic(graphql_type = "Query", variables = "ConnectionArgs")]
pub struct BlocksQuery {
    #[arguments(after: $after, before: $before, first: $first, last: $last)]
    pub blocks: BlockConnection,
}

#[derive(cynic::QueryFragment, Clone, Debug)]
pub struct BlockConnection {
    pub nodes: Vec<Block>,
}
