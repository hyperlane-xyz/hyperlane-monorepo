use ethers::types::{H160, U256};
use serde::{Deserialize, Serialize};
use tracing::instrument;

use crate::{types::Chain, RELAY_URL};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleEstimateArgs {
    // This is used in the URL, so no need
    // to serialize it
    #[serde(skip_serializing)]
    pub chain_id: Chain,
    pub payment_token: H160,
    pub gas_limit: u64,
    pub is_high_priority: bool,
    pub gas_limit_l1: Option<u64>,
}

// #[derive(Debug, Serialize)]
// #[serde(rename_all = "camelCase")]
// struct OracleEstimateQueryParams {
//     payment_token: H160,
//     gas_limit: u64,
//     is_high_priority: bool,
//     gas_limit_l1: Option<u64>,
// }

// impl From<OracleEstimateArgs> for OracleEstimateQueryParams {
//     fn from(args: OracleEstimateArgs) -> Self {
//         Self {
//             payment_token: args.payment_token,
//             gas_limit: args.gas_limit,
//             is_high_priority: args.is_high_priority,
//             gas_limit_l1: args.gas_limit_l1,
//         }
//     }
// }

#[derive(Debug)]
pub struct OracleEstimateCall {
    pub http: reqwest::Client,
    pub args: OracleEstimateArgs,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OracleEstimateCallResult {
    pub estimated_fee: U256,
    pub decimals: u32,
}

impl OracleEstimateCall {
    #[instrument]
    pub async fn run(self) -> Result<OracleEstimateCallResult, reqwest::Error> {
        let url = format!(
            "{}/oracles/{}/estimate",
            RELAY_URL,
            u32::from(self.args.chain_id)
        );
        println!("beforeee");
        let res = self.http.get(url).query(&self.args).send().await?;
        let result: OracleEstimateCallResult = res.json().await?;
        Ok(result)
    }
}

// #[tokio::test]
// async fn test_oracle_estimate() {
//     let call = OracleEstimateCall {
//         http: reqwest::Client::new(),
//         args: OracleEstimateArgs {
//             chain_id: Chain::Ethereum,
//             payment_token: NATIVE_FEE_TOKEN_ADDRESS,
//             gas_limit: 100000,
//             is_high_priority: false,
//             gas_limit_l1: None,
//         },
//     };

//     let response = call.run().await.unwrap();
//     println!("response {:?}", response);
// }
