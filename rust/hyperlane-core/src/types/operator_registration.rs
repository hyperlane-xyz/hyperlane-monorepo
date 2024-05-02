use async_trait::async_trait;
use derive_builder::Builder;
use serde::{Deserialize, Serialize};
use sha3::{digest::Update, Digest, Keccak256};
use std::collections::HashMap;
use std::fmt::{Debug, Formatter};
use std::str::FromStr;

use crate::utils::fmt_domain;
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
        let operator_h256: H256 = self.operator.into();
        let service_manager_h256: H256 = self.service_manager_address.into();
        let expiry_h256 = H256::from_low_u64_be(self.expiry as u64);

        let struct_hash = H256::from_slice(
            Keccak256::new()
                .chain(&self.operator_avs_registration_typehash)
                .chain(&operator_h256)
                .chain(&service_manager_h256)
                .chain(&self.salt)
                .chain(&expiry_h256)
                .finalize()
                .as_slice(),
        );
        H256::from_slice(
            Keccak256::new()
                .chain(b"\x19\x01")
                .chain(domain_separator(self.domain))
                .chain(&struct_hash)
                .finalize()
                .as_slice(),
        )
    }
}

/// An OperatorRegistration signed by an operator.
pub type SignedOperatorRegistration = SignedType<OperatorRegistration>;

/// Computes the domain separator for a given domain (for eigenlayer)
pub fn domain_separator(domain: u32) -> H256 {
    let domain_addresses: HashMap<u32, &str> = [
        (1, "0x135DDa560e946695d6f155dACaFC6f1F25C1F5AF"), // mainnet AVSDirectory address
        (17000, "0x055733000064333CaDDbC92763c58BF0192fFeBf"), // holesky AVSDirectory address
    ]
    .iter()
    .cloned()
    .collect();

    let address: H256 = H160::from_str(domain_addresses.get(&domain)
      .expect("Invalid domain for operator to the AVS, currently only Ethereum Mainnet and Holesky are supported.")).unwrap().into();

    let domain_typehash =
        Keccak256::digest("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    let domain: H256 = H256::from_low_u64_be(domain as u64);
    let eigenlayer_digest = Keccak256::digest("EigenLayer");

    H256::from_slice(
        Keccak256::new()
            .chain(&domain_typehash)
            .chain(&eigenlayer_digest)
            .chain(&domain.as_bytes())
            .chain(address.as_bytes())
            .finalize()
            .as_slice(),
    )
}
