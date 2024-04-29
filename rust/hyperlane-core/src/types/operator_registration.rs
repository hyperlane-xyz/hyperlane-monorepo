use async_trait::async_trait;
use derive_builder::Builder;
use serde::{Deserialize, Serialize};
use sha3::{digest::Update, Digest, Keccak256};
use std::fmt::{Debug, Formatter};

use crate::utils::{domain_separator, fmt_domain};
use crate::{Signable, SignedType, H160, H256};

/// Eigenlayer AVSDirectory registration details
#[derive(Builder, Clone, Eq, PartialEq, Serialize, Deserialize)]
pub struct OperatorRegistration {
    /// The domain of the chain the AVS is deployed on
    pub domain: u32,
    /// The EIP-712 typehash for the `Registration` struct used by the contract
    #[builder(default = "default_operator_avs_registration_typehash()")]
    pub operator_avs_registration_typehash: H256,
    /// The account registering as an operator
    pub operator: H160,
    /// The address of the service manager contract for the AVS that the operator is registering to
    pub service_manager_address: H160,
    /// A unique and single use value associated with the operator signature.
    pub salt: H256,
    /// Time (in sec) after which the approver's signature becomes invalid
    pub expiry: u32,
}

fn default_operator_avs_registration_typehash() -> H256 {
    let hash = Keccak256::digest(
        b"OperatorAVSRegistration(address operator,address avs,bytes32 salt,uint256 expiry)",
    );
    H256::from_slice(&hash)
}

impl Debug for OperatorRegistration {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "OperatorRegistration {{ avs_domain: {}, operator : {}, service_manager_address: {}, salt: {}, expiry: {} }}",
            fmt_domain(self.domain),
            self.operator,
            self.service_manager_address,
            self.salt,
            self.expiry
        )
    }
}

#[async_trait]
impl Signable for OperatorRegistration {
    fn signing_hash(&self) -> H256 {
        let struct_hash = H256::from_slice(
            Keccak256::new()
                .chain(&self.operator_avs_registration_typehash)
                .chain(&self.operator)
                .chain(&self.service_manager_address)
                .chain(&self.salt)
                .chain(self.expiry.to_be_bytes())
                .finalize()
                .as_slice(),
        );
        H256::from_slice(
            Keccak256::new()
                .chain(b"\x19\x01")
                .chain(domain_separator(self.domain, self.service_manager_address))
                .chain(&struct_hash)
                .finalize()
                .as_slice(),
        )
    }
}

/// An OperatorRegistration signed by an operator.
pub type SignedOperatorRegistration = SignedType<OperatorRegistration>;
