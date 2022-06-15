use crate::chains::Chain;
use crate::err::GelatoError;
use ethers::types::{Address, Bytes, U256};
use ethers::types::Signature;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use std::sync::Arc;
use tracing::info;
use tracing::instrument;

const GATEWAY_URL: &str = "https://gateway.api.gelato.digital";

#[derive(Debug, Clone)]
pub struct ForwardRequestArgs {
    pub chain_id: Chain,
    pub target: Address,
    pub data: Bytes,
    pub fee_token: Address,
    pub payment_type: PaymentType,
    pub max_fee: U256,
    pub gas: U256,
    pub sponsor: Address,
    pub sponsor_chain_id: Chain,
    pub nonce: U256,
    pub enforce_sponsor_nonce: bool,
    pub enforce_sponsor_nonce_ordering: bool,
}

#[derive(Debug, Clone)]
pub struct ForwardRequestCall {
    pub http: Arc<reqwest::Client>,
    pub args: ForwardRequestArgs,
    pub sig: Signature,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ForwardRequestCallResult {
    pub task_id: String,
}

impl ForwardRequestCall {
    #[instrument]
    pub async fn run(&self) -> Result<ForwardRequestCallResult, GelatoError> {
        let url = format!(
            "{}/metabox-relays/{}",
            GATEWAY_URL,
            u32::from(self.args.chain_id)
        );
        let http_args = HTTPArgs {
            args: self.args.clone(),
            sig: self.sig,
        };
        info!(?url, ?http_args);
        let res = self.http.post(url).json(&http_args).send().await?;
        let result = HTTPResult::from(res.json().await.unwrap());
        Ok(ForwardRequestCallResult::from(result))
    }
}

#[derive(Debug)]
struct HTTPArgs {
    args: ForwardRequestArgs,
    sig: Signature,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct HTTPResult {
    pub task_id: String,
}

impl Serialize for HTTPArgs {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("ForwardRequestHTTPArgs", 14)?;
        state.serialize_field("typeId", "ForwardRequest")?;
        state.serialize_field("chainId", &(u32::from(self.args.chain_id)))?;
        state.serialize_field("target", &self.args.target)?;
        state.serialize_field("data", &self.args.data)?;
        state.serialize_field("feeToken", &self.args.fee_token)?;
        // TODO(webbhorn): Get rid of the clone and cast.
        state.serialize_field("paymentType", &(self.args.payment_type.clone() as u64))?;
        state.serialize_field("maxFee", &self.args.max_fee.to_string())?;
        state.serialize_field("gas", &self.args.gas.to_string())?;
        state.serialize_field("sponsor", &self.args.sponsor)?;
        // TODO(webbhorn): Just implement a `From<Chain> for H160` directly?
        state.serialize_field("sponsorChainId", &(u32::from(self.args.sponsor_chain_id)))?;
        // TODO(webbhorn): Avoid narrowing conversion for serialization.
        state.serialize_field("nonce", &self.args.nonce.as_u128())?;
        state.serialize_field("enforceSponsorNonce", &self.args.enforce_sponsor_nonce)?;
        state.serialize_field(
            "enforceSponsorNonceOrdering",
            &self.args.enforce_sponsor_nonce_ordering,
        )?;
        state.serialize_field("sponsorSignature", &format!("0x{}", self.sig.to_string()))?;
        state.end()
    }
}

impl From<HTTPResult> for ForwardRequestCallResult {
    fn from(http: HTTPResult) -> ForwardRequestCallResult {
        ForwardRequestCallResult {
            task_id: http.task_id,
        }
    }
}

#[derive(Debug, Clone)]
pub enum PaymentType {
    Sync = 0,
    AsyncGasTank = 1,
    SyncGasTank = 2,
    SyncPullFee = 3,
}

// TODO(webbhorn): The signature verification stuff should be tested
// in fwd_req_sig.rs instead.
//
// TODO(webbhorn): the two test cases are basically the same, probably
// no need to duplicate.
//
// TODO(webbhorn): Include tests near boundary of large int
// overflows, e.g. is nonce representation as u128 for serialization
// purposes correct given ethers::types::U256 representation in
// OpArgs?
#[cfg(test)]
mod tests {
    use super::*;
    use crate::chains::Chain;
    use ethers::signers::{LocalWallet, Signer};
    use ethers::types::U256;

    // TODO(webbhorn): These constants are used in a couple other
    // places in this crate, should centralize them, or just be use
    // them inline in the test case.
    //
    // The sample data / parameters below, along with corresponding
    // expected digests and signatures, were validated by running the
    // Gelato Relay SDK demo "hello world" app with instrumented
    // logging, and recording the generated signatures and digests. A
    // LocalWallet with a randomly-generated private key was also
    // recorded.
    //
    // See
    // https://docs.gelato.network/developer-products/gelato-relay-sdk/quick-start
    // for more details.

    const EXAMPLE_DATA_FOR_TESTING: &str =
        "0x4b327067000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeaeeeeeeeeeeeeeeeee";
    const ETH_TOKEN_FOR_TESTING: &str = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const SPONSOR_CONTRACT_FOR_TESTING: &str = "0xEED5eA7e25257a272cb3bF37B6169156D37FB908";
    const TARGET_CONTRACT_FOR_TESTING: &str = "0x8580995EB790a3002A55d249e92A8B6e5d0b384a";
    const LOCAL_WALLET_KEY_FOR_TESTING: &str =
        "969e81320ae43e23660804b78647bd4de6a12b82e3b06873f11ddbe164ebf58b";

    const EXPECTED_JSON_REQUEST_CONTENT: &str = concat!(
        "{",
        r#""typeId":"ForwardRequest","#,
        r#""chainId":5,"#,
        r#""target":"0x8580995eb790a3002a55d249e92a8b6e5d0b384a","#,
        r#""data":"0x4b327067000000000000000000000000eeeeeeeeeeeeeee"#,
        r#"eeeeeeeeeaeeeeeeeeeeeeeeeee","#,
        r#""feeToken":"0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","#,
        r#""paymentType":1,"#,
        r#""maxFee":"1000000000000000000","#,
        r#""gas":"200000","#,
        r#""sponsor":"0xeed5ea7e25257a272cb3bf37b6169156d37fb908","#,
        r#""sponsorChainId":5,"#,
        r#""nonce":0,"#,
        r#""enforceSponsorNonce":false,"#,
        r#""enforceSponsorNonceOrdering":true,"#,
        r#""sponsorSignature":"#,
        r#""0xa0e6d94b1608d4d8888f72c9e1335def0d187e41dca0ffe"#,
        r#"9fcd9b4bf96c1c59a27447248fef6a70e53646c0a156656f642"#,
        r#"ff361f3ab14b9db5f446f3681538b91c"}"#
    );

    #[tokio::test]
    async fn sdk_test() {
        let fwd_req_args = ForwardRequestArgs {
            chain_id: Chain::Goerli,
            target: TARGET_CONTRACT_FOR_TESTING.parse().unwrap(),
            data: EXAMPLE_DATA_FOR_TESTING.parse().unwrap(),
            fee_token: ETH_TOKEN_FOR_TESTING.parse().unwrap(),
            payment_type: PaymentType::AsyncGasTank,
            max_fee: U256::from(1000000000000000000i64),
            gas: U256::from(200000i64),
            sponsor: SPONSOR_CONTRACT_FOR_TESTING.parse().unwrap(),
            sponsor_chain_id: Chain::Goerli,
            nonce: U256::from(0i64),
            enforce_sponsor_nonce: false,
            enforce_sponsor_nonce_ordering: true,
        };

        let wallet = LOCAL_WALLET_KEY_FOR_TESTING.parse::<LocalWallet>().unwrap();
        let sig = wallet.sign_typed_data(&fwd_req_args).await.unwrap();
        assert_eq!(
            sig.to_string(),
            concat!(
                "a0e6d94b1608d4d8888f72c9e1335def0d187e41dca0ffe9fcd",
                "9b4bf96c1c59a27447248fef6a70e53646c0a156656f642ff36",
                "1f3ab14b9db5f446f3681538b91c"
            )
        );

        let http_args = HTTPArgs {
            args: fwd_req_args,
            sig,
        };
        assert_eq!(
            EXPECTED_JSON_REQUEST_CONTENT,
            serde_json::to_string(&http_args).unwrap()
        );
    }

    // Parameters specified by Ed in Telegram.
    #[tokio::test]
    async fn ed_test_case() {
        let fwd_req_args = ForwardRequestArgs {
            chain_id: Chain::Goerli,
            target: TARGET_CONTRACT_FOR_TESTING.parse().unwrap(),
            data: EXAMPLE_DATA_FOR_TESTING.parse().unwrap(),
            fee_token: ETH_TOKEN_FOR_TESTING.parse().unwrap(),
            payment_type: PaymentType::AsyncGasTank,
            max_fee: U256::from(1000000000000000000i64),
            gas: U256::from(200000i64),
            sponsor: "97B503cb009670982ef9Ca472d66b3aB92fD6A9B".parse().unwrap(),
            sponsor_chain_id: Chain::Goerli,
            nonce: U256::from(0i64),
            enforce_sponsor_nonce: false,
            enforce_sponsor_nonce_ordering: true,
        };

        let wallet = "c2fc8dc5512c1fb5df710c3320daa1e1ebc41701a9d5b489692e888228aaf813"
            .parse::<LocalWallet>()
            .unwrap();
        let sig = wallet.sign_typed_data(&fwd_req_args).await.unwrap();
        assert_eq!(
            sig.to_string(),
            concat!(
                "18bf6c6bb1a3410308cd5b395f5a3fac067835233f28f1b08d52b447179b72f40a50dc37ef7a785b0d5ed741e84a4375b3833cf43b4dba46686f15185f20f2541c"
            )
        );
    }

    #[test]
    fn sdk_reply() {
        let reply_json = concat!(
            r#"{"taskId": "#,
            r#""0x053d975549b9298bb7672b20d3f7c0960df00d065e6f68c"#,
            r#"29abd8550b31cdbc2"}"#
        );
        let parsed: HTTPResult = serde_json::from_str(reply_json).unwrap();
        assert_eq!(
            parsed,
            HTTPResult {
                task_id: String::from(concat!(
                    "0x053d975549b9298bb7672b20d3f7c0960df00d",
                    "065e6f68c29abd8550b31cdbc2"
                )),
            }
        );
    }
}
