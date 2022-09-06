// use ethers::abi::token::Token;
// use ethers::types::transaction::eip712::{EIP712Domain, Eip712};
// use ethers::types::U256;
// use ethers::utils::keccak256;

// use crate::err::GelatoError;
// use crate::fwd_req_call::ForwardRequestArgs;

// // See @gelatonetwork/gelato-relay-sdk/package/dist/lib/index.js.
// const EIP_712_DOMAIN_NAME: &str = "GelatoRelayForwarder";
// const EIP_712_VERSION: &str = "V1";
// const EIP_712_TYPE_HASH_STR: &str = concat!(
//     "ForwardRequest(uint256 chainId,address target,bytes data,",
//     "address feeToken,uint256 paymentType,uint256 maxFee,",
//     "uint256 gas,address sponsor,uint256 sponsorChainId,",
//     "uint256 nonce,bool enforceSponsorNonce,",
//     "bool enforceSponsorNonceOrdering)"
// );

// impl Eip712 for ForwardRequestArgs {
//     type Error = GelatoError;
//     fn domain(&self) -> Result<EIP712Domain, Self::Error> {
//         Ok(EIP712Domain {
//             name: Some(String::from(EIP_712_DOMAIN_NAME)),
//             version: Some(String::from(EIP_712_VERSION)),
//             chain_id: Some(self.chain_id.into()),
//             verifying_contract: Some(self.chain_id.relay_fwd_addr()?),
//             salt: None,
//         })
//     }
//     fn type_hash() -> Result<[u8; 32], Self::Error> {
//         Ok(keccak256(EIP_712_TYPE_HASH_STR))
//     }
//     fn struct_hash(&self) -> Result<[u8; 32], Self::Error> {
//         Ok(keccak256(ethers::abi::encode(&[
//             Token::FixedBytes(ForwardRequestArgs::type_hash().unwrap().to_vec()),
//             Token::Int(U256::from(u32::from(self.chain_id))),
//             Token::Address(self.target),
//             Token::FixedBytes(keccak256(&self.data).to_vec()),
//             Token::Address(self.fee_token),
//             Token::Int(U256::from(self.payment_type.clone() as u64)),
//             Token::Int(self.max_fee),
//             Token::Int(self.gas),
//             Token::Address(self.sponsor),
//             Token::Int(U256::from(u32::from(self.sponsor_chain_id))),
//             Token::Int(self.nonce),
//             Token::Bool(self.enforce_sponsor_nonce),
//             Token::Bool(self.enforce_sponsor_nonce_ordering),
//         ])))
//     }
// }

// #[cfg(test)]
// mod tests {
//     use super::*;
//     use crate::test_data;
//     use ethers::signers::{LocalWallet, Signer};
//     use ethers::types::transaction::eip712::Eip712;
//     use ethers::utils::hex;

//     // The EIP712 typehash for a ForwardRequest is invariant to the actual contents of the
//     // ForwardRequest message, and is instead deterministic of the ABI signature. So we
//     // can test it without constructing any interesting-looking message.
//     #[test]
//     fn eip712_type_hash_gelato_forward_request() {
//         assert_eq!(
//             hex::encode(&ForwardRequestArgs::type_hash().unwrap()),
//             "4aa193de33aca882aa52ebc7dcbdbd732ad1356422dea011f3a1fa08db2fac37"
//         );
//     }

//     #[tokio::test]
//     async fn sdk_demo_data_eip_712() {
//         use ethers::signers::{LocalWallet, Signer};
//         let args = test_data::sdk_demo_data::new_fwd_req_args();
//         assert_eq!(
//             hex::encode(&args.domain_separator().unwrap()),
//             test_data::sdk_demo_data::EXPECTED_DOMAIN_SEPARATOR
//         );
//         assert_eq!(
//             hex::encode(&args.struct_hash().unwrap()),
//             test_data::sdk_demo_data::EXPECTED_STRUCT_HASH
//         );
//         assert_eq!(
//             hex::encode(&args.encode_eip712().unwrap()),
//             test_data::sdk_demo_data::EXPECTED_EIP712_ENCODED_PAYLOAD
//         );
//         let wallet = test_data::sdk_demo_data::WALLET_KEY
//             .parse::<LocalWallet>()
//             .unwrap();
//         let sig = wallet.sign_typed_data(&args).await.unwrap();
//         assert_eq!(
//             sig.to_string(),
//             test_data::sdk_demo_data::EXPECTED_EIP712_SIGNATURE
//         );
//     }

//     // A test case provided to us from the Gelato team. The actual `ForwardRequest` message
//     // contents is *almost* the same as the `sdk_demo_data` test message. (The sponsor address
//     // differs, so we override in this test case.) OUtside of the message contents, the
//     // Gelato-provided LocalWallet private key differs as well.
//     #[tokio::test]
//     async fn gelato_provided_signature_matches() {
//         let mut args = test_data::sdk_demo_data::new_fwd_req_args();
//         args.sponsor = "97B503cb009670982ef9Ca472d66b3aB92fD6A9B".parse().unwrap();
//         let wallet = "c2fc8dc5512c1fb5df710c3320daa1e1ebc41701a9d5b489692e888228aaf813"
//             .parse::<LocalWallet>()
//             .unwrap();
//         let sig = wallet.sign_typed_data(&args).await.unwrap();
//         assert_eq!(
//             sig.to_string(),
//             "18bf6c6bb1a3410308cd5b395f5a3fac067835233f28f1b08d52b447179b72f40a50dc37ef7a785b0d5ed741e84a4375b3833cf43b4dba46686f15185f20f2541c"
//             );
//     }
// }
