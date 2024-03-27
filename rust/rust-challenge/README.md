# Rust Challenge

## Notes

- `src/chain.rs`: Chains are entirely hardcoded to Infura endpoints. A proper solution would use mutliple providers, and allow configuring RPC endpoints via a config file. I see that that is currently implemented in the TypeScript CLI, so I did not put much effort into doing so here. I also only implemented chains required for basic testing (Mumbai and Sepolia).
- `ethers-rs versioning`: the monorepo uses forks of ethers-rs crates, and I needed to use ethers-middleware, which is not forked or in the workspace. If I used the workspace crates + ethers-middleware, I'd get compile errors like:

```
error[E0277]: the trait bound `ethers_providers::Provider<ethers_providers::Http>: ethers_middleware::Middleware` is not satisfied
   --> rust-challenge/src/eth.rs:102:53
    |
102 |         let client = Arc::new(SignerMiddleware::new(self.provider.clone(), signer.clone()));
    |                               --------------------- ^^^^^^^^^^^^^^^^^^^^^ the trait `ethers_middleware::Middleware` is not implemented for `ethers_providers::Provider<ethers_providers::Http>`
```

so I opted to just use the un-forked ethers-rs crates.

- `src/eth.rs`:
  - I think I only needed the `dispatch` method, and I didn't find any ABIs in the monorepo, so I just hardcoded the ABI signature for said method.
  - I didn't have enough time to spend on setting up gas configuration, so I just hardcoded the gas limit to 1_000_000 and price to 1_000_000_000 gwei.
  - Due to ethers-rs version mismatches, I couldn't cleanly use the hyperlane-core crate to listen for Messages from my contract, so I just listened for `dispatch` events and mapped them to `HyperlaneMessage` structs.
  - And because I'm not listening for `HyperlaneMessage`s directly, I have some janky conversion going on in terms of interpretting `Dispatch` evnts as `HyperlaneMessage`s.`
- Generally, I couldn't find great docs on using the Hyperlane crates, so I threw something basic together with the tools I knew how to use.

## Running

To send a message:

```sh
cargo run -- \
-p <your-private-key> \
send \
# Origin chain (sepolia or mumbai)
-o <origin-chain> \
# Destination chain (sepolia or mumbai)
-d <destination-chain> \
# Mailbox address on origin chain
-m <mailbox-address> \
# Recipient address on destination chain
-r <recipient-address> \
# Message to send
--message-body <message>
```

To listen for messages using a matching list:

```sh
cargo run -- \
listen \
# Origin chain (sepolia or mumbai)
-o <origin-chain> \
# Mailbox address on origin chain to listen on
-m <mailbox-address> \
# Matching list to match messages against
--matching-list <matching-list>
```

## Testing

A simple test can be run by:

Listening for all events against the Sepolia TestMailbox contract:

```sh
cargo run -- \
listen \
-o sepolia \
-m 0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766 \
--matching-list '[{"origindomain": "*", "senderaddress": "*", "destinationdomain": "*", "recipientaddress": "*"}, {}]'`
```

in one terminal while sending a simple message to the Sepolia TestMailbox contract in another terminal:

```sh
cargo run -- \
-p <your-private-key> \
send \
-o sepolia \
-d mumbai \
-m 0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766 \
-r 0xF45A4D54223DA32bf7b5D43a9a460Ef3C94C713B \
--message-body 'hello there'
```
