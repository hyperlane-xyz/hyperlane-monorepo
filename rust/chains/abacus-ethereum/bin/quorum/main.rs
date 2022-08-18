use ethers::prelude::{Http, JsonRpcClient, U64};

use quorum::*;

mod quorum;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let provider1 = "http://127.0.0.1:8545".parse::<Http>().unwrap();
    let provider2 = "http://127.0.0.1:8545".parse::<Http>().unwrap();
    let provider3 = "http://127.0.0.1:8545".parse::<Http>().unwrap();
    let quorum_provider = QuorumProvider::builder()
        .add_providers(
            [&provider1, &provider2, &provider3]
                .into_iter()
                .cloned()
                .map(WeightedProvider::new),
        )
        .quorum(Quorum::Majority)
        .build();

    let block_number: U64 = JsonRpcClient::request(&provider1, "eth_blockNumber", ())
        .await
        .expect("Failed to get block number");
    println!("Provider considers current block number to be {block_number}");

    let block_number: U64 = JsonRpcClient::request(&quorum_provider, "eth_blockNumber", ())
        .await
        .expect("Failed to get block number");
    println!("Quorum block number {block_number}");
}
