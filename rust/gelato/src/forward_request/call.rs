use crate::err::GelatoError;
use crate::forward_request::op::OpArgs;
use ethers::types::Signature;
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use std::sync::Arc;

const GATEWAY_URL: &str = "https://gateway.api.gelato.digital";

pub struct Call {
    pub http: Arc<reqwest::Client>,
    pub args: OpArgs,
    pub sig: Signature,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CallResult {
    pub task_id: String,
}

impl Call {
    pub async fn run(&self) -> Result<CallResult, GelatoError> {
        let url = format!(
            "{}/metabox-relays/{}",
            GATEWAY_URL,
            u32::from(self.args.chain_id)
        );
        let http_args = HTTPArgs {
            args: self.args.clone(),
            sig: self.sig,
        };
        let res = self.http.post(url).json(&http_args).send().await?;
        let result = HTTPResult::from(res.json().await.unwrap());
        dbg!(&result);
        Ok(CallResult::from(result))
    }
}

#[derive(Debug)]
struct HTTPArgs {
    args: OpArgs,
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
        state.serialize_field("paymentType", &(self.args.payment_type.clone() as u64))?;
        state.serialize_field("maxFee", &format!(r#"{}"#, self.args.max_fee.as_u128()))?;
        state.serialize_field("gas", &format!(r#"{}"#, self.args.gas.as_u128()))?;
        state.serialize_field("sponsor", &self.args.sponsor)?;
        state.serialize_field("sponsorChainId", &(u32::from(self.args.sponsor_chain_id)))?;
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

impl From<HTTPResult> for CallResult {
    fn from(http: HTTPResult) -> CallResult {
        CallResult {
            task_id: http.task_id,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chains::Chain;
    use crate::forward_request::op::PaymentType;
    use ethers::signers::{LocalWallet, Signer};
    use ethers::types::U256;
    #[tokio::test]
    async fn sdk_test() {
        let fwd_req_args = OpArgs {
            chain_id: Chain::Goerli,
            target: "0x8580995EB790a3002A55d249e92A8B6e5d0b384a"
                .parse()
                .unwrap(),
            data: "0x4b327067000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeaeeeeeeeeeeeeeeeee"
                .parse()
                .unwrap(),
            fee_token: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"
                .parse()
                .unwrap(),
            payment_type: PaymentType::AsyncGasTank,
            max_fee: U256::from(1000000000000000000i64),
            gas: U256::from(200000i64),
            sponsor: "0xEED5eA7e25257a272cb3bF37B6169156D37FB908"
                .parse()
                .unwrap(),
            sponsor_chain_id: Chain::Goerli,
            nonce: U256::from(0i64),
            enforce_sponsor_nonce: false,
            enforce_sponsor_nonce_ordering: true,
        };

        let wallet = "969e81320ae43e23660804b78647bd4de6a12b82e3b06873f11ddbe164ebf58b"
            .parse::<LocalWallet>()
            .unwrap();
        let sig = wallet.sign_typed_data(&fwd_req_args).await.unwrap();
        assert_eq!(
            sig.to_string(),
            "a0e6d94b1608d4d8888f72c9e1335def0d187e41dca0ffe9fcd9b4bf96c1c59a27447248fef6a70e53646c0a156656f642ff361f3ab14b9db5f446f3681538b91c",
        );

        let http_args = HTTPArgs {
            args: fwd_req_args,
            sig: sig,
        };
        // Generated with SDK with a static wallet key.
        let expected = r#"{"typeId":"ForwardRequest","chainId":5,"target":"0x8580995eb790a3002a55d249e92a8b6e5d0b384a","data":"0x4b327067000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeaeeeeeeeeeeeeeeeee","feeToken":"0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","paymentType":1,"maxFee":"1000000000000000000","gas":"200000","sponsor":"0xeed5ea7e25257a272cb3bf37b6169156d37fb908","sponsorChainId":5,"nonce":0,"enforceSponsorNonce":false,"enforceSponsorNonceOrdering":true,"sponsorSignature":"0xa0e6d94b1608d4d8888f72c9e1335def0d187e41dca0ffe9fcd9b4bf96c1c59a27447248fef6a70e53646c0a156656f642ff361f3ab14b9db5f446f3681538b91c"}"#;
        assert_eq!(expected, serde_json::to_string(&http_args).unwrap());
    }

    #[test]
    fn sdk_reply() {
        let reply_json =
            r#"{"taskId": "0x053d975549b9298bb7672b20d3f7c0960df00d065e6f68c29abd8550b31cdbc2"}"#;
        let parsed: HTTPResult = serde_json::from_str(reply_json).unwrap();
        assert_eq!(
            parsed,
            HTTPResult {
                task_id: String::from(
                    "0x053d975549b9298bb7672b20d3f7c0960df00d065e6f68c29abd8550b31cdbc2"
                ),
            }
        );
    }
}
