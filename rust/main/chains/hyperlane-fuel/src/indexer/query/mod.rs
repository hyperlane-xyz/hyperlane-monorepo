use std::ops::RangeInclusive;

use cynic::{GraphQlResponse, QueryBuilder};
use fuels::client::{PageDirection, PaginationRequest};
use reqwest::Client;
use tracing::warn;
use url::Url;

use hyperlane_core::{ChainCommunicationError, ChainResult};

pub mod types;
use types::*;

mod conversions;
use conversions::*;

/// A GraphQL client for querying the Fuel blockchain.
/// It's used due to the limitations of the Fuels Rust SDK.
pub struct FuelGraphQLClient {
    client: Client,
    url: Url,
}

impl FuelGraphQLClient {
    /// Create a new FuelGraphQLClient
    pub fn new(url: &Url) -> Self {
        Self {
            client: reqwest::Client::new(),
            url: url.clone(),
        }
    }

    /// Query blocks in a specific range
    pub async fn query_blocks_in_range(
        &self,
        range: &RangeInclusive<u32>,
    ) -> ChainResult<BlocksQuery> {
        let request = self.build_request(range);
        let operation: cynic::Operation<BlocksQuery, ConnectionArgs> =
            BlocksQuery::build(request.into());

        let response = self
            .client
            .post(self.url.clone())
            .json(&operation)
            .send()
            .await
            .map_err(ChainCommunicationError::from_other)?;

        let parsed_response = response
            .json::<GraphQlResponse<BlocksQuery>>()
            .await
            .map_err(ChainCommunicationError::from_other)?;

        self.handle_response(parsed_response)
    }

    /// Convert a range into a FuelVM pagination request
    fn build_request(&self, range: &RangeInclusive<u32>) -> PaginationRequest<String> {
        let range_start = range.start();
        let result_amount: u32 = range.end() - range.start();
        if *range_start == 0 {
            return PaginationRequest {
                cursor: None,
                results: result_amount as i32,
                direction: PageDirection::Forward,
            };
        }

        PaginationRequest {
            cursor: Some(range_start.to_string()),
            results: result_amount as i32,
            direction: PageDirection::Forward,
        }
    }

    /// Handle the response from the FuelVM GraphQL query
    fn handle_response(&self, response: GraphQlResponse<BlocksQuery>) -> ChainResult<BlocksQuery> {
        if let Some(errors) = &response.errors {
            if response.data.is_none() {
                return Err(ChainCommunicationError::from_other_str(
                    format!("Error executing custom FuelVM GraphQL query: {:?}", errors).as_str(),
                ));
            }

            for error in errors {
                warn!("Error executing custom FuelVM GraphQL query {:?}", error);
            }
        }

        match response.data {
            Some(data) => Ok(data),
            None => Err(ChainCommunicationError::from_other_str(
                "No data received from FuelVM GraphQL query",
            )),
        }
    }
}
