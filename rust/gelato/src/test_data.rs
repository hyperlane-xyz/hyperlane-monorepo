// // The sample data / parameters below, along with corresponding expected digests and signatures,
// // were validated by running the Gelato Relay SDK demo "hello world" app with instrumented
// // logging, and recording the generated signatures and digests. A LocalWallet with a
// // randomly-generated private key was also recorded.
// //
// // See https://docs.gelato.network/developer-products/gelato-relay-sdk/quick-start for more
// // details.
// //
// // Since it is useful to refer to these parameters from a handful of places for testing any
// // canonical request, it is shared with the whole crate from `test_data.rs`.
// #[cfg(test)]
// pub(crate) mod sdk_demo_data {
//     use ethers::types::U256;

//     use crate::{
//         chains::Chain,
//         fwd_req_call::{ForwardRequestArgs, PaymentType},
//     };

//     pub const CHAIN_ID: Chain = Chain::Goerli;
//     pub const TARGET_CONTRACT: &str = "0x8580995eb790a3002a55d249e92a8b6e5d0b384a";
//     pub const DATA: &str =
//         "0x4b327067000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeaeeeeeeeeeeeeeeeee";
//     pub const TOKEN: &str = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
//     pub const PAYMENT_TYPE: PaymentType = PaymentType::AsyncGasTank;
//     pub const MAX_FEE: i64 = 1_000_000_000_000_000_000;
//     pub const GAS: i64 = 200_000;
//     pub const SPONSOR_CONTRACT: &str = "0xeed5ea7e25257a272cb3bf37b6169156d37fb908";
//     pub const SPONSOR_CHAIN_ID: Chain = Chain::Goerli;
//     pub const NONCE: U256 = U256::zero();
//     pub const ENFORCE_SPONSOR_NONCE: bool = false;
//     pub const ENFORCE_SPONSOR_NONCE_ORDERING: bool = true;

//     // An actual ForwardRequestArgs struct built from the above data.
//     pub fn new_fwd_req_args() -> ForwardRequestArgs {
//         ForwardRequestArgs {
//             chain_id: CHAIN_ID,
//             target: TARGET_CONTRACT.parse().unwrap(),
//             data: DATA.parse().unwrap(),
//             gas_limit: Some(U256::from(GAS)),
//         }
//     }

//     // Expected EIP-712 data for ForwardRequest messages built with the above data, i.e. those
//     // returned by `new_fwd_req_args()`.  Signing implementation tested in the `fwd_req_sig`
//     // module.
//     pub const EXPECTED_DOMAIN_SEPARATOR: &str =
//         "5b86c8e692a12ffedb26520fb1cc801f537517ee74d7730a1d806daf2b0c2688";
//     pub const EXPECTED_STRUCT_HASH: &str =
//         "6a2d78b78f47d56209a1b28617f9aee0ead447384cbc6b55f66247991d4462b6";
//     pub const EXPECTED_EIP712_ENCODED_PAYLOAD: &str =
//         "e9841a12928faf38821e924705b2fae99936a23086a0555d57fac07880bebc74";

//     // An EIP-712 signature over `EXPECTED_EIP712_ENCODED_PAYLOAD` from a LocalWallet
//     // whose private key is `WALLET_KEY` should result in the EIP-712 signature
//     // `EXPECTED_EIP712_SIGNATURE`. Implementation is tested in `fwd_req_sig` module.
//     pub const WALLET_KEY: &str = "969e81320ae43e23660804b78647bd4de6a12b82e3b06873f11ddbe164ebf58b";
//     pub const EXPECTED_EIP712_SIGNATURE: &str =
//         "a0e6d94b1608d4d8888f72c9e1335def0d187e41dca0ffe9fcd9b4bf96c1c59a27447248fef6a70e53646c0a156656f642ff361f3ab14b9db5f446f3681538b91c";

//     // When sending a Gelato ForwardRequest built from the above
//     // contents with the above signature to the Gelato Gateway server, the HTTP request is expected
//     // to contain the following JSON contents in its body.
//     // Implementation of the special serialization rules is tested in `fwd_req_call` module.
//     pub const EXPECTED_JSON_REQUEST_CONTENT: &str = concat!(
//         "{",
//         r#""typeId":"ForwardRequest","#,
//         r#""chainId":5,"#,
//         r#""target":"0x8580995eb790a3002a55d249e92a8b6e5d0b384a","#,
//         r#""data":"0x4b327067000000000000000000000000eeeeeeeeeeeeeee"#,
//         r#"eeeeeeeeeaeeeeeeeeeeeeeeeee","#,
//         r#""feeToken":"0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","#,
//         r#""paymentType":1,"#,
//         r#""maxFee":"1000000000000000000","#,
//         r#""gas":"200000","#,
//         r#""sponsor":"0xeed5ea7e25257a272cb3bf37b6169156d37fb908","#,
//         r#""sponsorChainId":5,"#,
//         r#""nonce":0,"#,
//         r#""enforceSponsorNonce":false,"#,
//         r#""enforceSponsorNonceOrdering":true,"#,
//         r#""sponsorSignature":"#,
//         r#""0xa0e6d94b1608d4d8888f72c9e1335def0d187e41dca0ffe"#,
//         r#"9fcd9b4bf96c1c59a27447248fef6a70e53646c0a156656f642"#,
//         r#"ff361f3ab14b9db5f446f3681538b91c"}"#
//     );
// }
