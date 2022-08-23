use crate::chains::Chain;
use crate::err::GelatoError;
use ethers::types::{Address, Bytes, Signature, U256};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use tracing::info;
use tracing::instrument;

const GATEWAY_URL: &str = "https://relay.gelato.digital";

pub const NATIVE_FEE_TOKEN_ADDRESS: ethers::types::Address = Address::repeat_byte(0xEE);

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
    pub http: reqwest::Client,
    pub args: ForwardRequestArgs,
    pub signature: Signature,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ForwardRequestCallResult {
    pub task_id: String,
}

impl ForwardRequestCall {
    #[instrument]
    pub async fn run(self) -> Result<ForwardRequestCallResult, GelatoError> {
        let url = format!(
            "{}/metabox-relays/{}",
            GATEWAY_URL,
            u32::from(self.args.chain_id)
        );
        let http_args = HTTPArgs {
            args: self.args.clone(),
            signature: self.signature,
        };
        info!(?url, ?http_args);
        let res = self.http.post(url).json(&http_args).send().await?;
        tracing::info!(res=?res, "ForwardRequestCall res");
        let result: HTTPResult = res.json().await?;
        Ok(ForwardRequestCallResult::from(result))
    }
}

#[derive(Debug)]
struct HTTPArgs {
    args: ForwardRequestArgs,
    signature: Signature,
}

#[derive(Debug, Clone, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
struct HTTPResult {
    pub task_id: String,
}

// We could try to get equivalent serde serialization for this type via the typical attributes,
// like #[serde(rename_all...)], #[serde(flatten)], etc, but altogether there are enough changes
// piled on top of one another that it seems more readable to just explicitly rewrite the relevant
// fields with inline modifications below.
//
// In total, we have to make the following logical changes from the default serde serialization:
//     *  add a new top-level dict field 'typeId', with const literal value 'ForwardRequest'.
//     *  hoist the two struct members (`args` and `signature`) up to the top-level dict (equiv. to
//        `#[serde(flatten)]`).
//     *  make sure the integers for the fields `gas` and `maxfee` are enclosed within quotes,
//        since Gelato-server-side, they will be interpreted as ~bignums.
//     *  ensure all hex-string-type fields are prefixed with '0x', rather than a string of
//        ([0-9][a-f])+, which is expected server-side.
//     *  rewrite all field names to camelCase (equiv. to `#[serde(rename_all = "camelCase")]`).
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
        state.serialize_field("sponsorChainId", &(u32::from(self.args.sponsor_chain_id)))?;
        // TODO(webbhorn): Avoid narrowing conversion for serialization.
        state.serialize_field("nonce", &self.args.nonce.as_u128())?;
        state.serialize_field("enforceSponsorNonce", &self.args.enforce_sponsor_nonce)?;
        state.serialize_field(
            "enforceSponsorNonceOrdering",
            &self.args.enforce_sponsor_nonce_ordering,
        )?;
        state.serialize_field("sponsorSignature", &format!("0x{}", self.signature))?;
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

// TODO(webbhorn): Include tests near boundary of large int overflows, e.g. is nonce representation
// as u128 for serialization purposes correct given ethers::types::U256 representation in OpArgs?
#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_data;

    #[tokio::test]
    async fn sdk_demo_data_request() {
        use ethers::signers::{LocalWallet, Signer};
        let args = test_data::sdk_demo_data::new_fwd_req_args();
        let wallet = test_data::sdk_demo_data::WALLET_KEY
            .parse::<LocalWallet>()
            .unwrap();
        let signature = wallet.sign_typed_data(&args).await.unwrap();
        let http_args = HTTPArgs { args, signature };
        assert_eq!(
            serde_json::to_string(&http_args).unwrap(),
            test_data::sdk_demo_data::EXPECTED_JSON_REQUEST_CONTENT
        );
    }

    #[test]
    fn sdk_demo_data_json_reply_parses() {
        let reply_json =
            r#"{"taskId": "0x053d975549b9298bb7672b20d3f7c0960df00d065e6f68c29abd8550b31cdbc2"}"#;
        let parsed: HTTPResult = serde_json::from_str(&reply_json).unwrap();
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
