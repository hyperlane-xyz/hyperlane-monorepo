# Cosmos wire adapter

Sources: `rust/main/chains/hyperlane-cosmos`, pinned `hyperlane-cosmos-rs 0.1.4`, `hyperlane-cosmwasm-interface 0.0.6-rc6`, `cosmos-sdk-proto 0.26.1`, production `cometbft-rs` serializers.

Implemented:

- Native Hyperlane protobuf and CosmWasm JSON mailbox, Merkle hook, ISM, routing, multisig/aggregation queries and announcement reads.
- Configured `grpcUrls` remain HTTP/2 gRPC endpoints. `grpc.Transport` permits injected transports; `curl_grpc.CurlTransport` uses the optional shared dynamically loaded libcurl transport. There is no REST gateway substitution.
- Unary framing, remote status/trailers, historical response height, compression rejection, response limits, total/connect deadlines and cancellation. Request paths retain configured prefixes and query credentials.
- Source gRPC fallback snapshots/retry rounds and shared per-endpoint height health. Failed requests reorder priority after10 failures; successful endpoints probe latest validator height after120s, serialized across forks. Single-endpoint pools never probe. Typed cooperative read futures preserve independent request/probe phases across suspension, with owned responses and quota-bound snapshots; existing read-vote single-endpoint capture remains supported.
- Tendermint/CometBFT status, block, block-results, transaction, ABCI and explicit broadcast-commit wire calls. Network/height/transaction hash checks. Transaction request hashes use base64; response hashes use hex, matching `cometbft-rs`.
- Dispatch/delivery/Merkle insertion/gas payment events, plain/base64 attributes, native JSON string values and exact fee denomination checks.
- Standard/Ethermint/Injective base-account decode, account/sequence retrieval, unsigned DIRECT sign-doc construction, empty-signature simulation, source minimum gas multiplier of 2, exact decimal fee ceiling, source 100-block timeout, explicit injected signing and SHA256 transaction IDs. Sign validates configured public key and sign-doc/account/sequence/fee metadata before returning bytes for durable storage.

`Config` requires chain ID, address prefix, canonical asset, contract address width, gas price, multiplier and confirmations. No chain defaults are guessed. The decimal parser bounds precision to u256; source arbitrary-precision decimal text beyond that bound returns an error.

Security boundaries:

- Returned ABCI `unverified_proof_ops` are decoded only. No light-client/ICS23 verification claim.
- Native announcement transport errors propagate; they do not become empty successful location lists.
- No production key discovery, secret reads or implicit broadcast. Callers must persist signed bytes and sequence and reconcile uncertain submission by transaction hash before replacements.
- `agents/chain_source.Resources` binds the concrete clients to scraper and generic relayer/validator source drivers; read forks share endpoint health and native I/O owners. Native tests cover HTTP/2 SDK queries and source indexing into RocksDB. Mainnet rollout and every configured public endpoint remain unverified.
- Optional native libcurl supplies HTTP/2/TLS/DNS; this transport is not zero-dependency. Initialize a vetted explicit library before workers and join all requests before deinit.

Fixtures regenerate from independent Rust SDKs:

```sh
python3 zig/tools/fixture_pack.py restore-locks
cargo +1.98.0 run --manifest-path zig/src/altvm/reference/Cargo.toml --locked --offline --quiet -- cosmos > zig/src/cosmos/fixtures/sdk.json
cargo +1.98.0 clippy --manifest-path zig/src/altvm/reference/Cargo.toml --locked --offline -- -D warnings
```

Normal root tests are std-only except libc linkage and skip the optional native HTTP/2 test. Native transport can be exercised against the local built-in Node HTTP/2 server:

```sh
node zig/src/cosmos/testing/grpc-server.mjs
# Use the emitted localhost port; no production endpoint or key is needed.
HYPERLANE_COSMOS_GRPC_TEST_URL='http://127.0.0.1:PORT/prefix?key=fixture' zig test zig/src/root.zig -lc --test-filter cosmos
```

The native test checks exact SDK request bodies, mailbox/tree/ISM reads, framing/trailers/height binding and a real stalled-response total deadline. macOS may require the pinned SDK flags documented in the top-level Zig README.
