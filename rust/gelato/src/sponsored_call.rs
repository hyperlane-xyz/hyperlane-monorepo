use crate::chains::Chain;
use crate::err::GelatoError;
use crate::RELAY_URL;
use ethers::types::{Address, Bytes, U256};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};
use tracing::instrument;

pub const NATIVE_FEE_TOKEN_ADDRESS: ethers::types::Address = Address::repeat_byte(0xEE);

#[derive(Debug, Clone)]
pub struct SponsoredCallArgs {
    pub chain_id: Chain,
    pub target: Address,
    pub data: Bytes,
    pub gas_limit: Option<U256>,
}

#[derive(Debug, Clone)]
pub struct SponsoredCallCall {
    pub http: reqwest::Client,
    pub args: SponsoredCallArgs,
    pub sponsor_api_key: String,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct SponsoredCallCallResult {
    pub task_id: String,
}

impl SponsoredCallCall {
    #[instrument]
    pub async fn run(self) -> Result<SponsoredCallCallResult, GelatoError> {
        let url = format!("{}/relays/v2/sponsored-call", RELAY_URL,);
        let http_args = HTTPArgs {
            args: self.args.clone(),
            sponsor_api_key: self.sponsor_api_key,
        };
        let res = self.http.post(url).json(&http_args).send().await?;
        let result: HTTPResult = res.json().await?;
        Ok(SponsoredCallCallResult::from(result))
    }
}

#[derive(Debug)]
struct HTTPArgs {
    args: SponsoredCallArgs,
    sponsor_api_key: String,
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
//     *  add a new top-level dict field 'typeId', with const literal value 'SponsoredCall'.
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
        let mut state = serializer.serialize_struct("SponsoredCallHTTPArgs", 14)?;
        state.serialize_field("typeId", "SponsoredCall")?;
        state.serialize_field("chainId", &(u32::from(self.args.chain_id)))?;
        state.serialize_field("target", &self.args.target)?;
        state.serialize_field("data", &self.args.data)?;
        state.serialize_field("sponsorApiKey", &self.sponsor_api_key)?;
        if let Some(gas_limit) = &self.args.gas_limit {
            state.serialize_field("gasLimit", &gas_limit.to_string())?;
        }
        state.end()
    }
}

impl From<HTTPResult> for SponsoredCallCallResult {
    fn from(http: HTTPResult) -> SponsoredCallCallResult {
        SponsoredCallCallResult {
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
    // use crate::test_data;

    // #[tokio::test]
    // async fn sdk_demo_data_request() {
    //     let args = test_data::sdk_demo_data::new_fwd_req_args();
    //     let sponsor_api_key = "foo".into();
    //     let http_args = HTTPArgs { args, sponsor_api_key };
    //     assert_eq!(
    //         serde_json::to_string(&http_args).unwrap(),
    //         test_data::sdk_demo_data::EXPECTED_JSON_REQUEST_CONTENT
    //     );
    // }

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
