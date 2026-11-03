# Optional public HTTP RPC comparison

Measured separately from the controlled suite on 2026-11-03. [Results table](./public-rpc-results.md) and [all raw samples](./public-rpc-results.json) retain the improved median and worse observed tail.

After explicitly verifying a public Ethereum mainnet endpoint and obtaining an idle measurement window:

```sh
source ~/.nvm/nvm.sh
nvm use
node docs/performance/hot-paths/ts/public-rpc.mjs \
  --url https://ethereum-rpc.publicnode.com \
  --from 0x000000000000000000000000000000000000dEaD \
  --warmups 2 --pairs 15
```

`--prepare-only` compiles/imports both exact versioned source snapshots without making network calls. `--from` overrides the default public funded EOA used for simulation.

The benchmark calls each archived SDK's actual Ethers fee estimator through a real `StaticJsonRpcProvider` with chain ID 1. The simulated transaction sends zero ETH from a public EOA to itself. It never signs or broadcasts. The provider explicitly rejects `eth_send*` and accepts only `eth_estimateGas`, `eth_getBlockByNumber` and `eth_gasPrice`.

Preflight verifies chain ID 1, empty code and a positive balance for the public simulation sender using three read-only calls. Two warmups and fifteen measured AB/BA pairs then normally issue **102 JSON-RPC invocations** (3 per estimate), for **105 including preflight**. A shared hard limit allows at most **120 invocations total**, including preflight and warmups, and automatic throttle retries are disabled. Each estimate is followed by a 250 ms pause. Calls time out after eight seconds. If both versions fail all warmups, measurement stops and records the failure without claiming a performance result.

The raw output retains every measured/warmup request's method, duration and success, observed block numbers, fee/gas results, sample CPU/RSS, peak active requests, failures and exact source digests. Connection failures can occur before the request reaches the server; counts describe actual provider `send` invocations with retries disabled.

Only successful estimates contribute to latency percentiles. Attempt/failure counts and successfully paired samples remain explicit. Results compare one public endpoint under changing network, server and latest-block conditions; they do not establish a production-wide speedup. Both versions use separate provider instances within one process and share library/transport caches. Warmup is excluded. Failed estimates drain any still-running sibling read before the next version runs.
