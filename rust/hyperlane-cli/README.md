# hyperlane-cli

Hyperlane CLI, a command line interface for interacting with Hyperlane.

Commands:
- `send`: Dispatch a message to a Hyperlane Mailbox.
- `query`: Query a Hyperlane Mailbox; optionally provide a MatchingList config file to filter the results.

## Build

```
cargo build
```

## Getting started

```
cargo run -- --help

cargo run -- send --help

cargo run -- query --help

```

## Usage

### Send a message

```
# Send a message from Sepolia to Mumbai 
cargo run -- --origin-chain 11155111 --mailbox-address 0xCC737a94FecaeC165AbCf12dED095BB13F037685 --rpc-url https://rpc.sepolia.org send --address-destination 0x427DBf02E3a70dAf3699F62f0c936A3fEa8b0312 --chain-destination 80001 --bytes 0x73756261736D --private-key 1313d6b651f2dfcdd411a7a2ab90fc9ad71344df0bcb5fd742ba24deefae56f9

# Send a message from Sepolia to Alfajores 
cargo run -- --origin-chain 11155111 --mailbox-address 0xCC737a94FecaeC165AbCf12dED095BB13F037685 --rpc-url https://rpc.sepolia.org send --address-destination 0x427DBf02E3a70dAf3699F62f0c936A3fEa8b0312 --chain-destination 44787 --bytes 0x73756261736D --private-key 1313d6b651f2dfcdd411a7a2ab90fc9ad71344df0bcb5fd742ba24deefae56f9
```

### Query messages

```
# Query the Sepolia Mailbox, filter by matching-list-sample-address.json, and display the results in a table
cargo run -- --origin-chain 11155111 --mailbox-address 0xCC737a94FecaeC165AbCf12dED095BB13F037685 --rpc-url https://rpc.sepolia.org query --matching-list-file matching-list-sample-address.json --print-output-type table

# Query the Sepolia Mailbox, filter by matching-list-sample-mumbai.json, and display the results as json
cargo run -- --origin-chain 11155111 --mailbox-address 0xCC737a94FecaeC165AbCf12dED095BB13F037685 --rpc-url https://rpc.sepolia.org query --matching-list-file matching-list-sample-mumbai.json --print-output-type json

# Query the Sepolia Mailbox at a block depth of 100000, output the large result set into output.txt
cargo run -- --origin-chain 11155111 --mailbox-address 0xCC737a94FecaeC165AbCf12dED095BB13F037685 --rpc-url https://rpc.sepolia.org query --print-output-type json --block-depth 100000 > output.txt 
```