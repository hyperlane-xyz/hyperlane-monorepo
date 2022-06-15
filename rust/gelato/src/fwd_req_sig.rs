use ethers::abi::token::Token;
use ethers::types::transaction::eip712::{EIP712Domain, Eip712};
use ethers::types::U256;
use ethers::utils::keccak256;

use crate::err::GelatoError;
use crate::fwd_req_call::ForwardRequestArgs;

// See @gelatonetwork/gelato-relay-sdk/package/dist/lib/index.js.
const EIP_712_DOMAIN_NAME: &str = "GelatoRelayForwarder";
const EIP_712_VERSION: &str = "V1";
const EIP_712_TYPE_HASH_STR: &str = concat!(
    "ForwardRequest(uint256 chainId,address target,bytes data,",
    "address feeToken,uint256 paymentType,uint256 maxFee,",
    "uint256 gas,address sponsor,uint256 sponsorChainId,",
    "uint256 nonce,bool enforceSponsorNonce,",
    "bool enforceSponsorNonceOrdering)"
);

impl Eip712 for ForwardRequestArgs {
    type Error = GelatoError;
    fn domain(&self) -> Result<EIP712Domain, Self::Error> {
        Ok(EIP712Domain {
            name: String::from(EIP_712_DOMAIN_NAME),
            version: String::from(EIP_712_VERSION),
            chain_id: self.chain_id.into(),
            verifying_contract: self.chain_id.relay_fwd_addr()?,
            salt: None,
        })
    }
    fn type_hash() -> Result<[u8; 32], Self::Error> {
        Ok(keccak256(EIP_712_TYPE_HASH_STR))
    }
    fn struct_hash(&self) -> Result<[u8; 32], Self::Error> {
        Ok(keccak256(ethers::abi::encode(&[
            Token::FixedBytes(ForwardRequestArgs::type_hash().unwrap().to_vec()),
            Token::Int(U256::from(u32::from(self.chain_id))),
            Token::Address(self.target),
            Token::FixedBytes(keccak256(&self.data).to_vec()),
            Token::Address(self.fee_token),
            Token::Int(U256::from(self.payment_type.clone() as u64)),
            Token::Int(self.max_fee),
            Token::Int(self.gas),
            Token::Address(self.sponsor),
            Token::Int(U256::from(u32::from(self.sponsor_chain_id))),
            Token::Int(self.nonce),
            Token::Bool(self.enforce_sponsor_nonce),
            Token::Bool(self.enforce_sponsor_nonce_ordering),
        ])))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chains::Chain;
    use crate::fwd_req_call::PaymentType;
    use ethers::types::transaction::eip712::Eip712;
    use ethers::utils::hex;

    // The sample data / parameters below, along with corresponding expected digests and signatures,
    // were validated by running the Gelato Relay SDK demo "hello world" app with instrumented
    // logging, and recording the generated signatures and digests. A LocalWallet with a
    // randomly-generated private key was also recorded.
    // 
    // See https://docs.gelato.network/developer-products/gelato-relay-sdk/quick-start for more
    // details.

    const EXAMPLE_DATA_FOR_TESTING: &str = concat!(
        "0x4b327067000000000000000000000000",
        "eeeeeeeeeeeeeeeeeeeeeeeeaeeeeeeeeeeeeeeeee"
    );
    const ETH_TOKEN_FOR_TESTING: &str = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const SPONSOR_CONTRACT_FOR_TESTING: &str = "0xeed5ea7e25257a272cb3bf37b6169156d37fb908";
    const TARGET_CONTRACT_FOR_TESTING: &str = "0x8580995eb790a3002a55d249e92a8b6e5d0b384a";

    #[test]
    fn sdk_demo_app() {
        let args = ForwardRequestArgs {
            chain_id: Chain::Goerli,
            target: TARGET_CONTRACT_FOR_TESTING.parse().unwrap(),
            data: EXAMPLE_DATA_FOR_TESTING.parse().unwrap(),
            fee_token: ETH_TOKEN_FOR_TESTING.parse().unwrap(),
            payment_type: PaymentType::AsyncGasTank,
            max_fee: U256::from(1000000000000000000i64),
            gas: U256::from(200000i64),
            sponsor: SPONSOR_CONTRACT_FOR_TESTING.parse().unwrap(),
            sponsor_chain_id: Chain::Goerli,
            nonce: U256::zero(),
            enforce_sponsor_nonce: false,
            enforce_sponsor_nonce_ordering: true,
        };
        assert_eq!(
            hex::encode(&args.domain_separator().unwrap()),
            "5b86c8e692a12ffedb26520fb1cc801f537517ee74d7730a1d806daf2b0c2688"
        );
        assert_eq!(
            hex::encode(&ForwardRequestArgs::type_hash().unwrap()),
            "4aa193de33aca882aa52ebc7dcbdbd732ad1356422dea011f3a1fa08db2fac37"
        );
        assert_eq!(
            hex::encode(&args.struct_hash().unwrap()),
            "6a2d78b78f47d56209a1b28617f9aee0ead447384cbc6b55f66247991d4462b6"
        );
        assert_eq!(
            hex::encode(&args.encode_eip712().unwrap()),
            "e9841a12928faf38821e924705b2fae99936a23086a0555d57fac07880bebc74"
        );
    }
}
