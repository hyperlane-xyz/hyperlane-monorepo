# Hyperlane Rust Challenge CLI

This CLI tool is designed for sending and querying messages using the Hyperlane protocol between Ethereum-based blockchains. 

## Getting Started

### Prerequisites

- Rust and Cargo installed on your system.
- An Ethereum node access URL (e.g., via Infura or Alchemy).
- A funded Ethereum wallet address.

### Installation

Clone the repository and navigate to the project directory:

```bash
git clone [REPOSITORY_URL]
cd hyperlane-rust-challenge
```

### Build the project using Cargo:

```bash
cargo build --release
```

### Configuration

```bash
The first time you run a command, the tool will generate an Ethereum private key and store it in a .env file in your project directory. Ensure this wallet is funded with Ether for transaction fees.
```

## Usage

### Sending a Message

To send a message, use the send command with the required parameters:

```bash
cargo run -p hyperlane-rust-challenge -- -p [NODE_URL] -m [MAILBOX_ADDRESS] send --id [DESTINATION_CHAIN_ID] --destination-address [RECIPIENT_ADDRESS] --message [MESSAGE_HEX] --igp [INTERCHAIN_GAS_PAYMASTER_ADDRESS]

```

Example:
```bash
cargo run -p hyperlane-rust-challenge -- -p https://sepolia.infura.io/v3/APIKEY -m 0xCC737a94FecaeC165AbCf12dED095BB13F037685 send --id 80001 --destination-address 36FdA966CfffF8a9Cdc814f546db0e6378bFef35 --message 0x68656C6C6F20776F726C64 --igp 0x8f9C3888bFC8a5B25AED115A82eCbb788b196d2a
```

### Querying Message

To query messages, use the `search` command:

```bash
cargo run -p hyperlane-rust-challenge -- -p [NODE_URL] -m [MAILBOX_ADDRESS] search --from [START_BLOCK] --to [END_BLOCK]
```

Example:

```bash
cargo run -p hyperlane-rust-challenge -- -p https://sepolia.infura.io/v3/APIKEY -m 0xCC737a94FecaeC165AbCf12dED095BB13F037685 search --from 4687656 --to 4687658
```