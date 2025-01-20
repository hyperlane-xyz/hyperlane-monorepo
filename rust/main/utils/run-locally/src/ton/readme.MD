### Environment Variables
Before running the scripts, you need to set the required environment variables. These variables configure domains, keys, and other parameters.

List of Variables:

- `MNEMONIC` — The mnemonic phrase used for wallet operations.
- `WALLET_VERSION` — The wallet version (e.g., `v4`).
- `API_KEY` — The API key for external services.
- `DISPATCH_DOMAIN` — The source domain for message dispatch.
- `TARGET_DOMAIN` — The target domain for message delivery.
- `TON_ADDRESS` — The TON network address for refund purposes.

### Description for variables:
#### 🔑 `MNEMONIC`
The mnemonic phrase used for wallet operations.

#### 💾 `WALLET_VERSION`
The wallet version (e.g., `v4`).

#### 🔐 `API_KEY`
The API key for external services.

#### 🌐 `DISPATCH_DOMAIN`
The source domain for message dispatch.

#### 📨 `TARGET_DOMAIN`
The target domain for message delivery.

#### 🏦 `TON_ADDRESS`
The TON network address for refund purposes.

### Example of Setting Environment Variables
You can set the variables directly in your shell:

```shell
export MNEMONIC="your-mnemonic-phrase"
export WALLET_VERSION="v4"
export API_KEY="your-api-key"
export DISPATCH_DOMAIN="777001"
export TARGET_DOMAIN="777002"
export TON_ADDRESS="EQC2..."
```

### To run tests, use the following command:
```bash
RUST_LOG=info cargo test --release --package run-locally --bin run-locally --features ton test-utils -- ton::test --nocapture > logs.log
```