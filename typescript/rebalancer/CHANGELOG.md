# @hyperlane-xyz/rebalancer

## 29.2.0

### Minor Changes

- e40bf51: The deBridge DLN inventory adapter was added for Ethereum, BSC, Arbitrum, Tron, and Solana. API responses were bound to the requested route and a configurable basis-point limit before exact token approvals and simulated execution. Disabled registry metadata was excluded from external bridge chain maps.
- 311b28c: Movable-collateral routes gained configurable settlement adapters. LayerZero OFT transfers were tracked by their exact GUID and confirmed against the finalized destination receipt, recipient, and amount, while source-committed failures remained suppressed for the running process and existing routes retained Hyperlane message delivery by default.
- 46781ac: Config-driven route exclusions were added so unsupported chain pairs are not proposed for execution.
- 584d09a: Source-started rebalance actions were recorded in memory before broadcast to suppress duplicate execution within a running process.
- e41a746: The LayerZero inventory bridge was added using registry-resolved TokenBridgeOft adapters, exact approvals, and bounded token and native fees. Disabled and unsupported chain metadata was ignored when constructing LayerZero chain maps.
- 8237f59: The swaps.xyz executor was changed to validate provider-agnostic response bounds and simulate arbitrary provider payloads without requiring provider-specific calldata decoding. Pending status variants were accepted without weakening route-identity checks, and refreshed exact-output quotes were bounded by the configured quote-loss limit.
- 866134f: Unsigned swaps.xyz Solana preparation was shared by monitor-only checks and live execution, including refreshed quote-loss validation.
- f7976c2: Unsigned swaps.xyz Tron preparation was shared by monitor-only checks and live execution, including refreshed quote loss validation.
- 8237f59: An EVM and Tron swaps.xyz external bridge was added with strict response, quote-loss, signer, transaction, and settlement-status validation.
- 866134f: Solana-source swaps.xyz execution was added with simulated wallet effects bound to the accepted quote.

### Patch Changes

- 584d09a: Recorded primary and approval submission identities at broadcast boundaries. Released only proven unsubmitted work, reconciled pending approvals at finality, and retained source-committed failures across intent TTL expiry. Disabled automatic Solana blockhash re-signing for inventory execution.
- 584d09a: Deferred execution until a fresh monitor snapshot after tracker settlement changes. Prevented inventory movements from being duplicated when delivery completed after the cycle balance sample, and deferred execution when tracker synchronization failed.
- 8237f59: Allowed refreshed swaps quotes within the original loss and slippage budgets while preserving reserved inputs and exact-output targets. Preserved rate-limit cooldowns across requests without increasing registration retries, and measured payload freshness from the successful request attempt.
- 8237f59: Bounded swaps.xyz response bodies and registration retries, preserving terminal HTTP errors and recovering registration only for explicitly missing transfers.
- d61a29e: Completed uneconomic inventory remainders before capacity checks and documented full-intent prefunding so temporary limits do not leave dust blocking later work.
- 46781ac: Collateral deficit allocation was restricted to enabled routes while retaining transfer-origin preference. Unknown top-level runtime configuration fields were rejected at startup.
- 866134f: Fixed unsigned swaps.xyz preflight invocation through symlinked paths so the script reports validation results instead of silently exiting.
- e40bf51: Unsigned order preparation, generic native-value limits, simulation, and bounded refresh after stale approvals were added. Matching finalized source and destination order evidence was required before declaring settlement, including Tron solidified blocks.
- e40bf51: Bound deBridge settlement to the accepted destination, validated quote decimals against chain data, and kept request deadlines active through response bodies. Preserved signed Solana identities and exposed supported native asset handling.
- 46781ac: Denylisted movable-collateral messages were excluded from stuck-action gauges and warnings while their source reservations were retained. Synchronization counts were corrected for ignored messages with settlement references.
- 46781ac: Fixed constrained route allocation so disabled pairs no longer strand feasible rebalances. Rejected misspelled chain and destination controls instead of silently enabling routes.
- d61a29e: The xERC20 extra-bridge type was made explicit, and legacy entries were identified on-chain, so CCIP token pools were excluded from managed-lockbox metrics without hiding RPC failures.
- 584d09a: Required the complete chain finality policy before releasing failed source transactions or settled approvals, including Tron solidification and the conservative default when reorg metadata was missing.
- 584d09a: Preserved observed inventory submission identities through delegated signer errors so confirmation failures could not be misclassified as unsubmitted.
- e41a746: LayerZero inventory settlement was bound to the accepted recipient, source OFT event, and confirmed destination receipt so unverified deliveries remained reserved. Preparation failures were classified before submission, and Tron addresses were normalized for token and signer checks.
- 866134f: Bounded swaps.xyz Solana transaction fees independently from native account spending and added unsigned fee sampling so operators can validate the limits while the service remains monitor-only.
- 584d09a: Exposed reserved-action ages and reasons independently of external synchronization, preserved outage diagnostics after draining concurrent work, and avoided repeated RPC reads for finalized successful source transactions.
- d61a29e: Reused lockbox token resolution during each inventory rebalance cycle and refreshed it on subsequent cycles. Failed reads were evicted to permit recovery.
- f7976c2: Updated Tron broadcast regression coverage to exercise composed submission observers and preserve source transaction identity.
- 311b28c: OFT settlement reused the shared receipt verifier and was bounded by the exact collateral snapshot. Named finality was resolved once, failed snapshot reads deferred execution, and effective OFT routes were validated after destination overrides to prevent incompatible endpoint configurations from starting.
- e41a746: Required solidified Tron source and destination receipts before completing OFT settlements, in addition to configured confirmation and snapshot bounds.

  Restricted inventory OFT quoting to routes with equal local token decimals so unsupported conversions failed before funds were submitted.

- 6f1ef9b: Applied each movable-collateral fee allowance to a single transaction and reconciled its receipt and residue before advancing that origin. Kept origins with ambiguous submissions or cleanup reserved across cycles while allowing independent origins to proceed.
- 311b28c: Validated every enabled movable-collateral settlement family before approvals or source submission, rejecting missing OFT adapters and ambiguous RPC results instead of discovering untrackable transfers after sending.
- 46781ac: The positional warp config override was preserved when external bridge API keys were added. Completed swaps.xyz responses without amount data were rejected instead of reporting zero, with source reservations retained for subsequent reconciliation.
- e40bf51: Added error diagnostics for unresolved inventory submissions and status failures while preserving their reservations, and removed unused status-expiry bookkeeping.
- 584d09a: Indexed Explorer recovery by message and source transaction per batch, preserving chain identity and case-sensitive Solana signatures. Kept distinct messages dispatched by the same transaction separate.
- 699732b: LayerZero settlement recipients were made explicit assertions of the monitored collateral address and the router’s allowed destination, preserving exact receipt binding.
- 6f1ef9b: The movable-collateral rebalancer was updated to approve exact collateral-token bridge fees and revoke unused allowance after each transaction, retaining unresolved submissions and cleanup before advancing the origin.
- 584d09a: Rebalancing was deferred until a fresh balance sample after user transfers or newly discovered actions completed against moving block tags during synchronization. Numeric snapshots remained usable after delivery at the same block. Delivery lookup failures were propagated so incomplete synchronization could not authorize execution.
- c317ae7: Tron strategy chains were configured with a Tron signer so movable-collateral transactions can be broadcast through their configured RPC endpoint.
- 584d09a: The default in-memory rebalance intent TTL was increased to two weeks, and active bridge settlement now blocks duplicate inventory intents.
- d61a29e: Added xERC20 and VS xERC20 lockbox collateral support, including wrapped token resolution for external bridge inventory transfers.
- 584d09a: Preserved source transaction recovery before denylist accounting exclusions, preventing settled rebalance messages from retaining duplicate collateral credit while keeping unsettled inventory reservations.
- 584d09a: Preserved observed submission state, recovered finalized source failures without repeating uncertain transfers, and isolated unavailable inventory snapshots from movable collateral execution. Added reserved-action age diagnostics and recovery instructions for memory-only tracking.
- e40bf51: Inventory movements were reserved before bridge submission and retained across ambiguous sends, cancellation statuses, and tracking expiry to prevent duplicate transfers. Proven pre-send failures remained retryable, and approval identities were tracked separately from primary transfers.
- f32ac07: Recorded source transaction identities before confirmation and kept uncertain execution reserved. LiFi authorization paths were restricted to observed transactions, and unsupported multi-transaction signing was rejected.

  Standardized exact ERC20 allowances and separated approval identities from primary transfers. Receipt waits preserved transaction replacement handling and returned typed timeouts; reverted approval receipts were rejected.

- 6f1ef9b: Required configured confirmation depth and chain finality before allowance cleanup, including Tron solid-block checks, through a reusable receipt-finality policy.
- e41a746: Preserved the default 32-block Tron receipt depth when finalized balance reads replaced unsupported historical queries, and rejected invalid receipt confirmation counts.
- e41a746: Reported when a verified solid Tron receipt was already reflected in finalized balances while settlement still awaited configured confirmations. Propagated unavailable settlement verification so callers deferred stale balance decisions without releasing reservations.
- e40bf51: Bounded deBridge quote refreshes by the original economic budget and preserved settlement intent in transfer identities without accumulating process-local expectations. Measured payload freshness from the successful HTTP attempt.
- e41a746: Bounded LayerZero Scan response bodies independently of fetch cancellation so stalled settlement lookups remained pending without blocking later reconciliation.
- 584d09a: Separated pre-broadcast and post-broadcast E2E failure injection. Verified retry for proven unsubmitted work and settlement of an exposed source transaction without duplicating the movement.
- 8237f59: Rejected swaps.xyz exact-output quotes and refreshed payloads whose expected output fell below the requested target while preserving the accepted slippage allowance.
- 8237f59: Added unsigned swaps.xyz EVM preparation and refreshed stale payloads after approvals within the original input and output limits. Revalidated payload deadlines before submission without retrying exposed source transactions.
- 8237f59: Bound swaps.xyz quote refreshes to reserved input, validated decimals and requested slippage independently, and required matching transfer identities before settlement. Classified preparation failures and checked native principal funding.
- 866134f: Bound Solana swap debits and broadcast signatures to the requested transfer, and rejected unsupported native SOL routes before preparation.
- f7976c2: Used the Tron RPC provider for swap token metadata so configured headers were retained. Checked native principal funding and accepted valid exact-output transfers below their reserved maximum.
- e40bf51: Bounded deBridge HTTP requests through body consumption independently of fetch cancellation, preventing stalled responses from blocking reconciliation.
- 311b28c: Read Tron balances and message delivery from explicit native solidified state instead of unsupported numeric historical queries. Deferred strategy decisions after moving-state settlement changes, incomplete adapter reads, or balance-visible OFT receipts awaiting depth; retained pending evidence until verified completion.
- 311b28c: Bounded Tron collateral snapshots by the solidified head as well as configured block depth, keeping balance and settlement checks on the same confirmed boundary.
- e41a746: Rejected ambiguous enabled OFT chain metadata instead of silently selecting the last duplicate chain ID.
- d61a29e: Bounded inventory deposits by current xERC20 burn and mint capacity, token fees, and pending deposits while preserving actual collateral balances for allocation.
- 6f1ef9b: Revoked residual ERC20 collateral allowances before zero-fee rebalances so later fee increases cannot consume an old approval.
- Updated dependencies [5ad5b80]
- Updated dependencies [e40bf51]
- Updated dependencies [d61a29e]
- Updated dependencies [f32ac07]
- Updated dependencies [8509874]
- Updated dependencies [e40bf51]
- Updated dependencies [e40bf51]
- Updated dependencies [d5e4e91]
  - @hyperlane-xyz/sdk@46.0.0
  - @hyperlane-xyz/tron-sdk@26.1.0
  - @hyperlane-xyz/utils@46.0.0
  - @hyperlane-xyz/metrics@1.0.7
  - @hyperlane-xyz/core@12.3.0
  - @hyperlane-xyz/provider-sdk@11.0.4

## 29.1.0

### Minor Changes

- 2c32db0: The `relayerDenylist` pending transfer middleware was extended to rebalance messages, to which only `match` rules that set nothing but `messageId` apply. Denied rebalance messages are no longer recovered at startup or on later syncs, and a tracked rebalance intent whose in-progress messages are all denied stops counting as incoming collateral without any change to its status, so delivery checks and the intent TTL still apply. Broader `match` rules and `address` rules do not affect rebalance accounting, and inventory intents are unaffected. A rebalance message is meant to be denied only after its funds settled another way: an unsettled denied one is replaced by the strategy, and removing or expiring the rule makes it count again. Explorer queries made while a denylist refresh is in progress now wait for it instead of filtering with the previous rules.
- bdeb314: An optional `pendingTransferMiddlewares` config was added to skip pending transfers that will never be delivered. The `relayerDenylist` middleware applies the relayer runtime denylist, and the `blacklistIsm` middleware applies BlacklistIsms in the destination router's ISM.

### Patch Changes

- aa84958: Removed batch barriers from bounded async maps, parallelized independent gas simulation and fee reads, and bounded concurrent rebalancer monitor reads to reduce polling latency. Failed maps stopped scheduling new work and drained active calls before rejecting, preserving backpressure across retries.

  Failed inventory or confirmed-block supply reads prevented the monitor from emitting a partial polling cycle, avoiding fabricated zero balances or latest-state supplies in confirmed-block events.

  Failed numeric Tron block lookups also prevented latest-state supply from being emitted, while intentional optional named tags remained supported.

- c520224: Invariant regular expressions were reused across calls, redundant URL parsing was removed from RPC-header and explorer helpers, and independent token reads were overlapped with bounded concurrency and failure draining. URL normalization, validation, and dependent read ordering were preserved.
- Updated dependencies [d2ea605]
- Updated dependencies [bdeb314]
- Updated dependencies [048d1f3]
- Updated dependencies [f265d2f]
- Updated dependencies [fe5dfda]
- Updated dependencies [8b65668]
- Updated dependencies [aa84958]
- Updated dependencies [e48ffe7]
- Updated dependencies [4623acb]
- Updated dependencies [d0ec60c]
- Updated dependencies [63fa540]
- Updated dependencies [c520224]
- Updated dependencies [d770c3b]
- Updated dependencies [1baa78e]
- Updated dependencies [6e5db5f]
- Updated dependencies [7be44b5]
- Updated dependencies [9ef15ff]
- Updated dependencies [8868234]
- Updated dependencies [02c6ef4]
- Updated dependencies [2bc0b3e]
- Updated dependencies [48cd574]
  - @hyperlane-xyz/sdk@45.2.0
  - @hyperlane-xyz/core@12.3.0
  - @hyperlane-xyz/utils@45.2.0
  - @hyperlane-xyz/metrics@1.0.6
  - @hyperlane-xyz/provider-sdk@11.0.3

## 29.0.5

### Patch Changes

- Updated dependencies [b6fdd2d]
- Updated dependencies [a7b65cb]
- Updated dependencies [1467e4c]
- Updated dependencies [a27ce72]
- Updated dependencies [4b0f32c]
- Updated dependencies [447569f]
- Updated dependencies [b43bc9f]
- Updated dependencies [0ceb556]
- Updated dependencies [7203aec]
- Updated dependencies [341418a]
- Updated dependencies [5c6593b]
- Updated dependencies [62225a3]
- Updated dependencies [0063de6]
- Updated dependencies [77dbf5d]
- Updated dependencies [5a8eed5]
- Updated dependencies [670000c]
- Updated dependencies [bfbb755]
  - @hyperlane-xyz/sdk@45.1.0
  - @hyperlane-xyz/metrics@1.0.5
  - @hyperlane-xyz/utils@45.1.0
  - @hyperlane-xyz/core@12.2.0
  - @hyperlane-xyz/provider-sdk@11.0.2

## 29.0.4

### Patch Changes

- Updated dependencies [4efffd5]
- Updated dependencies [35d3002]
- Updated dependencies [fe26a26]
- Updated dependencies [19dbb59]
  - @hyperlane-xyz/sdk@45.0.1
  - @hyperlane-xyz/metrics@1.0.4
  - @hyperlane-xyz/utils@45.0.1
  - @hyperlane-xyz/core@12.2.0
  - @hyperlane-xyz/provider-sdk@11.0.1

## 29.0.3

### Patch Changes

- 12678bc: Added opt-in Sealevel v1 sending and configurable receipt reads per chain. V1 transactions moved compute limits and priority fees into the header and enforced version-specific size limits, while other SVMs retained v0 defaults.

  Separated v1 sending activation from RPC read support, preserved v0 offline governance, and carried caller-configured heap and loaded-data budgets across transaction versions.

- c1576a3: Skipped Explorer rebalance-action discovery when no bridge addresses were configured, avoiding an empty-result HTTP query while retaining tracked-action delivery checks.
- a8d6bf0: Reused the collateral address from the current managed-lockbox balance observation when reading token metadata, avoiding a duplicate contract lookup while retaining fresh metadata and standalone lookup behavior.
- 9a59116: Updated Solana clients to versions with transaction v1 codecs while preserving existing transaction-version defaults.
- c1576a3: Deferred LiFi SDK initialization until a configured external bridge was needed, reducing startup work for rebalancers without LiFi inventory execution.
- c1576a3: Reused the transfer gas quote within native-token cost estimation, avoiding a duplicate quote request while preserving fee reservations and standalone estimation behavior.
- c1576a3: Coalesced concurrent CoinGecko lookups for the same token ID, reducing duplicate metrics price requests while preserving cache expiry and retries after failures.
- 27d55d2: Removed unused Express dependencies from the rebalancer package.
- Updated dependencies [e0d3394]
- Updated dependencies [b83bac5]
- Updated dependencies [9b9de8d]
- Updated dependencies [4975a40]
- Updated dependencies [d02c93e]
- Updated dependencies [a8d6bf0]
- Updated dependencies [ee50f43]
- Updated dependencies [12678bc]
- Updated dependencies [0aeb76a]
- Updated dependencies [a8d6bf0]
- Updated dependencies [9a59116]
- Updated dependencies [a8d6bf0]
- Updated dependencies [d26e4c4]
- Updated dependencies [ebf3922]
- Updated dependencies [87b2c63]
- Updated dependencies [28eda66]
- Updated dependencies [f05bb6d]
- Updated dependencies [8373a74]
- Updated dependencies [0015102]
- Updated dependencies [a8d6bf0]
- Updated dependencies [6f7b511]
- Updated dependencies [249517a]
- Updated dependencies [2762075]
- Updated dependencies [f9cf910]
- Updated dependencies [323faae]
- Updated dependencies [55e6699]
- Updated dependencies [e994943]
- Updated dependencies [28eda66]
- Updated dependencies [6eaa8c6]
- Updated dependencies [11d5de3]
- Updated dependencies [98ec7d5]
- Updated dependencies [2a938f3]
- Updated dependencies [43f89c6]
- Updated dependencies [4e2ab65]
- Updated dependencies [4c644c0]
- Updated dependencies [4ad4577]
- Updated dependencies [f64f992]
- Updated dependencies [d26e4c4]
- Updated dependencies [692cdb4]
- Updated dependencies [ea5b010]
- Updated dependencies [b83bac5]
- Updated dependencies [67f3cd3]
  - @hyperlane-xyz/sdk@45.0.0
  - @hyperlane-xyz/metrics@1.0.3
  - @hyperlane-xyz/provider-sdk@11.0.0
  - @hyperlane-xyz/core@12.2.0
  - @hyperlane-xyz/utils@45.0.0

## 29.0.2

### Patch Changes

- Updated dependencies [16df6ee]
  - @hyperlane-xyz/sdk@44.0.2
  - @hyperlane-xyz/metrics@1.0.2
  - @hyperlane-xyz/utils@44.0.2
  - @hyperlane-xyz/core@12.1.0
  - @hyperlane-xyz/provider-sdk@10.0.2

## 29.0.1

### Patch Changes

- f269e03: Zod was updated to 4.5.4 to prevent function-valued default factories from running during schema cycle detection and compilation.
- Updated dependencies [f269e03]
  - @hyperlane-xyz/provider-sdk@10.0.1
  - @hyperlane-xyz/sdk@44.0.1
  - @hyperlane-xyz/metrics@1.0.1
  - @hyperlane-xyz/utils@44.0.1
  - @hyperlane-xyz/core@12.1.0

## 29.0.0

### Major Changes

- 6fbe5ad: The Starknet TypeScript stack was upgraded from starknet.js v7 to v8.9.2 to support the JSON-RPC v0.9 endpoints. Account and Contract call sites were migrated to the v8 options-object constructors, fee estimation was updated to the new resourceBounds shape, and dispatch-event parsing now passes the required ABI parser. Starknet wallet dependencies were upgraded for starknet.js v8 compatibility, and the minimum supported Node.js version is now 22 across published runtime dependents.

### Patch Changes

- Updated dependencies [85c44af]
- Updated dependencies [6fbe5ad]
  - @hyperlane-xyz/sdk@44.0.0
  - @hyperlane-xyz/utils@44.0.0
  - @hyperlane-xyz/metrics@1.0.0
  - @hyperlane-xyz/provider-sdk@10.0.0
  - @hyperlane-xyz/core@12.1.0

## 28.0.0

### Major Changes

- 8bcc7ab: Zod was upgraded to 4.5.2 across the TypeScript workspace. Public schemas and validation types were migrated to Zod 4, recursive fee configuration types were made explicit, application entrypoints adopted compiled parsing, and validation errors were changed to use Zod 4's built-in formatting.

### Patch Changes

- Updated dependencies [0848474]
- Updated dependencies [e76189e]
- Updated dependencies [3ced099]
- Updated dependencies [a00b342]
- Updated dependencies [b58c7eb]
- Updated dependencies [60fc463]
- Updated dependencies [8bcc7ab]
- Updated dependencies [7cf9c01]
- Updated dependencies [8d91ef8]
- Updated dependencies [11f2dee]
  - @hyperlane-xyz/sdk@43.0.0
  - @hyperlane-xyz/provider-sdk@9.0.0
  - @hyperlane-xyz/utils@43.0.0
  - @hyperlane-xyz/metrics@0.2.40
  - @hyperlane-xyz/core@12.1.0

## 27.3.18

### Patch Changes

- Updated dependencies [1713edd]
- Updated dependencies [9003bab]
- Updated dependencies [aa29187]
- Updated dependencies [f0f8a56]
- Updated dependencies [1b136e1]
- Updated dependencies [1b136e1]
- Updated dependencies [1b136e1]
- Updated dependencies [9a8bb17]
  - @hyperlane-xyz/sdk@42.0.0
  - @hyperlane-xyz/metrics@0.2.39
  - @hyperlane-xyz/utils@42.0.0
  - @hyperlane-xyz/core@12.1.0
  - @hyperlane-xyz/provider-sdk@8.1.3

## 27.3.17

### Patch Changes

- Updated dependencies [c201794]
  - @hyperlane-xyz/sdk@41.3.1
  - @hyperlane-xyz/metrics@0.2.38
  - @hyperlane-xyz/utils@41.3.1
  - @hyperlane-xyz/core@12.1.0
  - @hyperlane-xyz/provider-sdk@8.1.2

## 27.3.16

### Patch Changes

- Updated dependencies [4a21153]
- Updated dependencies [c328efa]
- Updated dependencies [4a21153]
- Updated dependencies [4a21153]
- Updated dependencies [322a418]
- Updated dependencies [d5d7d1a]
  - @hyperlane-xyz/sdk@41.3.0
  - @hyperlane-xyz/metrics@0.2.37
  - @hyperlane-xyz/utils@41.3.0
  - @hyperlane-xyz/core@12.1.0
  - @hyperlane-xyz/provider-sdk@8.1.1

## 27.3.15

### Patch Changes

- Updated dependencies [bd4e5f0]
- Updated dependencies [e7666ef]
- Updated dependencies [5fac94d]
- Updated dependencies [5899416]
- Updated dependencies [5fac94d]
  - @hyperlane-xyz/provider-sdk@8.1.0
  - @hyperlane-xyz/sdk@41.2.0
  - @hyperlane-xyz/core@12.1.0
  - @hyperlane-xyz/metrics@0.2.36
  - @hyperlane-xyz/utils@41.2.0

## 27.3.14

### Patch Changes

- @hyperlane-xyz/sdk@41.1.0
- @hyperlane-xyz/metrics@0.2.35
- @hyperlane-xyz/utils@41.1.0
- @hyperlane-xyz/core@12.0.0
- @hyperlane-xyz/provider-sdk@8.0.4

## 27.3.13

### Patch Changes

- Updated dependencies [0057c5d]
- Updated dependencies [fa19409]
- Updated dependencies [1a32515]
- Updated dependencies [1ba623d]
- Updated dependencies [fcb4331]
- Updated dependencies [eb24243]
- Updated dependencies [72738e2]
- Updated dependencies [fa19409]
- Updated dependencies [7846658]
- Updated dependencies [0765fe0]
- Updated dependencies [b1c6b7e]
- Updated dependencies [a09ba71]
- Updated dependencies [d9426bc]
  - @hyperlane-xyz/sdk@41.0.0
  - @hyperlane-xyz/utils@41.0.0
  - @hyperlane-xyz/metrics@0.2.34
  - @hyperlane-xyz/core@12.0.0
  - @hyperlane-xyz/provider-sdk@8.0.3

## 27.3.12

### Patch Changes

- Updated dependencies [745fb77]
- Updated dependencies [745fb77]
- Updated dependencies [469da6d]
- Updated dependencies [745fb77]
- Updated dependencies [74f3760]
- Updated dependencies [abeeb52]
- Updated dependencies [8944dd2]
- Updated dependencies [eb9c37c]
- Updated dependencies [3a74600]
- Updated dependencies [57b1e14]
- Updated dependencies [f3a6a4e]
- Updated dependencies [d6e923f]
- Updated dependencies [4c4f3f9]
- Updated dependencies [4c4f3f9]
- Updated dependencies [5830b8e]
- Updated dependencies [d3bbedf]
- Updated dependencies [e5908e9]
- Updated dependencies [8944dd2]
- Updated dependencies [89e6a8e]
- Updated dependencies [c2301b2]
- Updated dependencies [de37b68]
- Updated dependencies [1cac66f]
- Updated dependencies [c0ca851]
- Updated dependencies [a7f757b]
- Updated dependencies [4acd9a6]
- Updated dependencies [c6a2f61]
  - @hyperlane-xyz/core@12.0.0
  - @hyperlane-xyz/sdk@40.0.0
  - @hyperlane-xyz/metrics@0.2.33
  - @hyperlane-xyz/utils@40.0.0
  - @hyperlane-xyz/provider-sdk@8.0.2

## 27.3.11

### Patch Changes

- Updated dependencies [4976bb1]
- Updated dependencies [6c9210b]
- Updated dependencies [086ec59]
  - @hyperlane-xyz/sdk@39.1.0
  - @hyperlane-xyz/utils@39.1.0
  - @hyperlane-xyz/metrics@0.2.32
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@8.0.1

## 27.3.10

### Patch Changes

- Updated dependencies [f41f9fd]
- Updated dependencies [ba0e9c1]
- Updated dependencies [4ef1fde]
- Updated dependencies [43eb24a]
- Updated dependencies [406b5c7]
- Updated dependencies [11e215e]
- Updated dependencies [bf7c658]
- Updated dependencies [7e40466]
- Updated dependencies [496198d]
- Updated dependencies [4bebbbf]
- Updated dependencies [735793b]
- Updated dependencies [2d398b9]
- Updated dependencies [15b249c]
- Updated dependencies [6967bef]
- Updated dependencies [213f626]
- Updated dependencies [3811ba9]
- Updated dependencies [6c2ca1d]
- Updated dependencies [1a31d04]
- Updated dependencies [9997aee]
  - @hyperlane-xyz/sdk@39.0.0
  - @hyperlane-xyz/provider-sdk@8.0.0
  - @hyperlane-xyz/metrics@0.2.31
  - @hyperlane-xyz/utils@39.0.0
  - @hyperlane-xyz/core@11.3.1

## 27.3.9

### Patch Changes

- Updated dependencies [961a89d]
- Updated dependencies [2208b91]
- Updated dependencies [2208b91]
- Updated dependencies [2208b91]
- Updated dependencies [197b1e0]
- Updated dependencies [293abdc]
  - @hyperlane-xyz/sdk@38.0.0
  - @hyperlane-xyz/provider-sdk@7.2.0
  - @hyperlane-xyz/metrics@0.2.30
  - @hyperlane-xyz/utils@38.0.0
  - @hyperlane-xyz/core@11.3.1

## 27.3.8

### Patch Changes

- Updated dependencies [92909f8]
- Updated dependencies [262073e]
- Updated dependencies [df34a68]
- Updated dependencies [262073e]
- Updated dependencies [af8e1f6]
- Updated dependencies [cc4bdb6]
- Updated dependencies [c7895b6]
- Updated dependencies [262073e]
- Updated dependencies [6e803be]
- Updated dependencies [cb0c7c9]
- Updated dependencies [a82c918]
- Updated dependencies [262073e]
- Updated dependencies [351cf01]
- Updated dependencies [5122e71]
- Updated dependencies [262073e]
- Updated dependencies [262073e]
- Updated dependencies [262073e]
- Updated dependencies [31f8b51]
- Updated dependencies [97e8ca1]
- Updated dependencies [955281d]
- Updated dependencies [9c8b435]
  - @hyperlane-xyz/sdk@37.0.0
  - @hyperlane-xyz/provider-sdk@7.1.0
  - @hyperlane-xyz/metrics@0.2.29
  - @hyperlane-xyz/utils@37.0.0
  - @hyperlane-xyz/core@11.3.1

## 27.3.7

### Patch Changes

- Updated dependencies [d288e7b]
- Updated dependencies [d288e7b]
- Updated dependencies [d288e7b]
- Updated dependencies [019201a]
- Updated dependencies [cc722b8]
- Updated dependencies [9cd7606]
- Updated dependencies [2821252]
- Updated dependencies [a6a3a33]
- Updated dependencies [2821252]
- Updated dependencies [d288e7b]
- Updated dependencies [d288e7b]
- Updated dependencies [aa41ce4]
- Updated dependencies [2f9d783]
- Updated dependencies [9bdab1d]
- Updated dependencies [d288e7b]
- Updated dependencies [cf6857e]
- Updated dependencies [5527cd0]
- Updated dependencies [32b87ad]
- Updated dependencies [cf6857e]
  - @hyperlane-xyz/sdk@36.0.0
  - @hyperlane-xyz/utils@36.0.0
  - @hyperlane-xyz/provider-sdk@7.0.0
  - @hyperlane-xyz/metrics@0.2.28
  - @hyperlane-xyz/core@11.3.1

## 27.3.6

### Patch Changes

- Updated dependencies [88e51ed]
- Updated dependencies [fb63f5f]
- Updated dependencies [889c68a]
- Updated dependencies [fb63f5f]
- Updated dependencies [92ef474]
- Updated dependencies [f0b325a]
- Updated dependencies [6db4aee]
- Updated dependencies [babb3d0]
- Updated dependencies [867ce3c]
- Updated dependencies [b77faf4]
- Updated dependencies [fb63f5f]
- Updated dependencies [fb63f5f]
  - @hyperlane-xyz/sdk@35.2.0
  - @hyperlane-xyz/metrics@0.2.27
  - @hyperlane-xyz/utils@35.2.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@6.1.1

## 27.3.5

### Patch Changes

- Updated dependencies [d1b6f0a]
- Updated dependencies [830ce1d]
- Updated dependencies [9cdf9eb]
  - @hyperlane-xyz/provider-sdk@6.1.0
  - @hyperlane-xyz/sdk@35.1.0
  - @hyperlane-xyz/metrics@0.2.26
  - @hyperlane-xyz/utils@35.1.0
  - @hyperlane-xyz/core@11.3.1

## 27.3.4

### Patch Changes

- Updated dependencies [06a5b6b]
- Updated dependencies [da1cfb1]
- Updated dependencies [4bb1c3e]
- Updated dependencies [93c2290]
  - @hyperlane-xyz/sdk@35.0.1
  - @hyperlane-xyz/utils@35.0.1
  - @hyperlane-xyz/metrics@0.2.25
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@6.0.4

## 27.3.3

### Patch Changes

- Updated dependencies [38479d0]
- Updated dependencies [4adf279]
- Updated dependencies [7089676]
- Updated dependencies [44aa432]
- Updated dependencies [631d7e7]
- Updated dependencies [6c687ee]
- Updated dependencies [a8c9430]
  - @hyperlane-xyz/sdk@35.0.0
  - @hyperlane-xyz/metrics@0.2.24
  - @hyperlane-xyz/utils@35.0.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@6.0.3

## 27.3.2

### Patch Changes

- Updated dependencies [9a1ce26]
- Updated dependencies [f758a70]
- Updated dependencies [2151352]
- Updated dependencies [b8a600c]
  - @hyperlane-xyz/sdk@34.0.0
  - @hyperlane-xyz/metrics@0.2.23
  - @hyperlane-xyz/utils@34.0.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@6.0.2

## 27.3.1

### Patch Changes

- Updated dependencies [9ad1bd0]
- Updated dependencies [530f02e]
- Updated dependencies [9670e43]
- Updated dependencies [cc90a8f]
  - @hyperlane-xyz/sdk@33.1.1
  - @hyperlane-xyz/metrics@0.2.22
  - @hyperlane-xyz/utils@33.1.1
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@6.0.1

## 27.3.0

### Minor Changes

- 054b178: Added Tron blockchain support to the rebalancer using ProtocolType.Tron. Tron chains were treated as EVM-like for signer creation, block tag resolution, gas estimation, and transaction receipt parsing. The LiFi bridge was updated to gracefully skip Tron chains as no Tron-compatible aggregator is available.

### Patch Changes

- 7756d0a: LiFi chain metadata resolution was fixed for non-EVM chain ID collisions during rebalancer bridge execution.
- Updated dependencies [6f4b790]
- Updated dependencies [bfe4d2e]
- Updated dependencies [6929388]
- Updated dependencies [47649b7]
- Updated dependencies [bfe4d2e]
- Updated dependencies [0b1c1d1]
- Updated dependencies [d9dec53]
  - @hyperlane-xyz/sdk@33.1.0
  - @hyperlane-xyz/provider-sdk@6.0.0
  - @hyperlane-xyz/metrics@0.2.21
  - @hyperlane-xyz/utils@33.1.0
  - @hyperlane-xyz/core@11.3.1

## 27.2.14

### Patch Changes

- Updated dependencies [b864cca]
- Updated dependencies [1f918d0]
- Updated dependencies [78199f4]
  - @hyperlane-xyz/provider-sdk@5.1.0
  - @hyperlane-xyz/sdk@33.0.2
  - @hyperlane-xyz/utils@33.0.2
  - @hyperlane-xyz/metrics@0.2.20
  - @hyperlane-xyz/core@11.3.1

## 27.2.13

### Patch Changes

- 959c42a: Mixed-decimal inventory follow-ups were fixed by failing fast on missing bridged supply, tightening bridge plan coverage, and formatting monitored inventory balances with token-aware decimals.
- Updated dependencies [a2081df]
- Updated dependencies [4c91737]
  - @hyperlane-xyz/sdk@33.0.1
  - @hyperlane-xyz/metrics@0.2.19
  - @hyperlane-xyz/utils@33.0.1
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@5.0.3

## 27.2.12

### Patch Changes

- Updated dependencies [dc8e560]
  - @hyperlane-xyz/sdk@33.0.0
  - @hyperlane-xyz/metrics@0.2.18
  - @hyperlane-xyz/utils@33.0.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@5.0.2

## 27.2.11

### Patch Changes

- Updated dependencies [611b911]
- Updated dependencies [c6de4c9]
  - @hyperlane-xyz/sdk@32.0.1
  - @hyperlane-xyz/metrics@0.2.17
  - @hyperlane-xyz/utils@32.0.1
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@5.0.1

## 27.2.10

### Patch Changes

- Updated dependencies [e4da110]
- Updated dependencies [d588eb5]
- Updated dependencies [3dc6367]
- Updated dependencies [ab17263]
- Updated dependencies [ebde778]
- Updated dependencies [fa08f2a]
  - @hyperlane-xyz/sdk@32.0.0
  - @hyperlane-xyz/provider-sdk@5.0.0
  - @hyperlane-xyz/metrics@0.2.16
  - @hyperlane-xyz/utils@32.0.0
  - @hyperlane-xyz/core@11.3.1

## 27.2.9

### Patch Changes

- Updated dependencies [f9c8f83]
  - @hyperlane-xyz/sdk@31.2.1
  - @hyperlane-xyz/metrics@0.2.15
  - @hyperlane-xyz/utils@31.2.1
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@4.3.4

## 27.2.8

### Patch Changes

- Updated dependencies [35fb5c8]
  - @hyperlane-xyz/sdk@31.2.0
  - @hyperlane-xyz/metrics@0.2.14
  - @hyperlane-xyz/utils@31.2.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@4.3.3

## 27.2.7

### Patch Changes

- Updated dependencies [8a082af]
- Updated dependencies [c8fe242]
- Updated dependencies [8a082af]
  - @hyperlane-xyz/sdk@31.1.0
  - @hyperlane-xyz/metrics@0.2.13
  - @hyperlane-xyz/utils@31.1.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/provider-sdk@4.3.2

## 27.2.6

### Patch Changes

- Updated dependencies [d5168fc]
  - @hyperlane-xyz/utils@31.0.1
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/metrics@0.2.12
  - @hyperlane-xyz/provider-sdk@4.3.1
  - @hyperlane-xyz/sdk@31.0.1

## 27.2.5

### Patch Changes

- Updated dependencies [44626fb]
- Updated dependencies [df33d41]
- Updated dependencies [4963b32]
- Updated dependencies [9003721]
- Updated dependencies [7ad1f9e]
- Updated dependencies [69e6b3f]
- Updated dependencies [fc0a1cf]
  - @hyperlane-xyz/sdk@31.0.0
  - @hyperlane-xyz/provider-sdk@4.3.0
  - @hyperlane-xyz/core@11.3.1
  - @hyperlane-xyz/metrics@0.2.11
  - @hyperlane-xyz/utils@31.0.0

## 27.2.4

### Patch Changes

- Updated dependencies [26d682b]
  - @hyperlane-xyz/sdk@30.1.1
  - @hyperlane-xyz/metrics@0.2.10
  - @hyperlane-xyz/utils@30.1.1
  - @hyperlane-xyz/core@11.3.0
  - @hyperlane-xyz/provider-sdk@4.2.5

## 27.2.3

### Patch Changes

- Updated dependencies [9ac480a]
- Updated dependencies [9eefa2d]
- Updated dependencies [4c4462f]
- Updated dependencies [696da11]
- Updated dependencies [71f0ca4]
- Updated dependencies [46dda6c]
- Updated dependencies [ac1acbb]
- Updated dependencies [d38fad1]
- Updated dependencies [cfed1d2]
- Updated dependencies [9061916]
- Updated dependencies [2057d1a]
- Updated dependencies [d41d088]
- Updated dependencies [e1f35a7]
- Updated dependencies [b691b87]
- Updated dependencies [7018cc6]
- Updated dependencies [ef4399b]
- Updated dependencies [3fef31c]
- Updated dependencies [d98726f]
- Updated dependencies [40356c6]
- Updated dependencies [6f8c503]
- Updated dependencies [f2749a6]
- Updated dependencies [5eae48e]
- Updated dependencies [6bd4fd1]
- Updated dependencies [57e46b1]
- Updated dependencies [993de2b]
- Updated dependencies [b5f897c]
- Updated dependencies [9515191]
  - @hyperlane-xyz/core@11.3.0
  - @hyperlane-xyz/sdk@30.1.0
  - @hyperlane-xyz/metrics@0.2.9
  - @hyperlane-xyz/utils@30.1.0
  - @hyperlane-xyz/provider-sdk@4.2.4

## 27.2.2

### Patch Changes

- Updated dependencies [ac297da]
- Updated dependencies [77db719]
- Updated dependencies [e1ed158]
- Updated dependencies [d0dbf1a]
- Updated dependencies [37255ba]
- Updated dependencies [7646819]
- Updated dependencies [95c2891]
- Updated dependencies [7646819]
  - @hyperlane-xyz/core@11.2.0
  - @hyperlane-xyz/sdk@30.0.0
  - @hyperlane-xyz/provider-sdk@4.2.3
  - @hyperlane-xyz/metrics@0.2.8
  - @hyperlane-xyz/utils@30.0.0

## 27.2.1

### Patch Changes

- Updated dependencies [a8192d7]
- Updated dependencies [a891402]
  - @hyperlane-xyz/sdk@29.1.0
  - @hyperlane-xyz/metrics@0.2.7
  - @hyperlane-xyz/utils@29.1.0
  - @hyperlane-xyz/core@11.1.0
  - @hyperlane-xyz/provider-sdk@4.2.2

## 27.2.0

### Minor Changes

- 602912c: The ExplorerClient `toBytea` helper was updated to support multi-protocol addresses (Solana, Starknet, etc.) by resolving the chain's protocol type and delegating to `addressToByteHexString` for correct byte-length encoding.

  **Note:** The `ExplorerClient` constructor signature changed from `(baseUrl)` to `(baseUrl, getProtocol)`. Consumers using the `IExplorerClient` interface are unaffected; direct instantiation of `ExplorerClient` must pass the new `getProtocol` parameter.

### Patch Changes

- Updated dependencies [96508ed]
  - @hyperlane-xyz/sdk@29.0.1
  - @hyperlane-xyz/metrics@0.2.6
  - @hyperlane-xyz/utils@29.0.1
  - @hyperlane-xyz/core@11.1.0
  - @hyperlane-xyz/provider-sdk@4.2.1

## 27.1.3

### Patch Changes

- 084c6b6: The TypeScript packages were updated to support TypeScript 6.0 and to make ambient type loading explicit so the future TypeScript 7.0 upgrade is smoother.
- Updated dependencies [cc6d57b]
- Updated dependencies [3c6b1ad]
- Updated dependencies [084c6b6]
  - @hyperlane-xyz/sdk@29.0.0
  - @hyperlane-xyz/utils@29.0.0
  - @hyperlane-xyz/metrics@0.2.5
  - @hyperlane-xyz/provider-sdk@4.2.0
  - @hyperlane-xyz/core@11.1.0

## 27.1.2

### Patch Changes

- Updated dependencies [5caac66]
- Updated dependencies [6c715a7]
- Updated dependencies [6c715a7]
- Updated dependencies [2e622e8]
- Updated dependencies [e93a4c8]
  - @hyperlane-xyz/provider-sdk@4.1.0
  - @hyperlane-xyz/core@11.1.0
  - @hyperlane-xyz/sdk@28.1.0
  - @hyperlane-xyz/metrics@0.2.4
  - @hyperlane-xyz/utils@28.1.0

## 27.1.1

### Patch Changes

- Updated dependencies [83767b9]
- Updated dependencies [b9c6844]
- Updated dependencies [a6b7bf3]
- Updated dependencies [5a5d172]
- Updated dependencies [a4a74d8]
  - @hyperlane-xyz/provider-sdk@4.0.0
  - @hyperlane-xyz/sdk@28.0.0
  - @hyperlane-xyz/core@11.0.3
  - @hyperlane-xyz/metrics@0.2.3
  - @hyperlane-xyz/utils@28.0.0

## 27.1.0

### Patch Changes

- Updated dependencies [de5f6b5]
- Updated dependencies [a1f9e41]
- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
- Updated dependencies [b892e61]
- Updated dependencies [7af7728]
  - @hyperlane-xyz/sdk@27.1.0
  - @hyperlane-xyz/provider-sdk@3.1.0
  - @hyperlane-xyz/utils@27.1.0
  - @hyperlane-xyz/metrics@0.2.2
  - @hyperlane-xyz/core@11.0.2

## 27.0.0

### Major Changes

- b05e242: Mixed-mode rebalancing was added to enable simultaneous movable collateral (EVM) and inventory (multi-VM) execution within a single rebalancer configuration, enabling cross-protocol rebalancing across EVM and Sealevel chains.

  **BREAKING CHANGES:**
  - `inventorySigner` config field was replaced with `inventorySigners`, a per-protocol map (`Partial<Record<ProtocolType, { address: string; key?: string } | string>>`). Existing configs using `inventorySigner` must migrate to the new schema.
  - `IExternalBridge.execute()` signature changed from `(quote, privateKey: string)` to `(quote, privateKeys: Partial<Record<ProtocolType, string>>)`. All `IExternalBridge` implementations must update their `execute` method to accept the new multi-protocol key map.

  **New features:**
  - Per-protocol signer architecture supporting EVM + Sealevel keys simultaneously.
  - `transferRemote` execution refactored to use `WarpCore.getTransferRemoteTxs()` for multi-VM compatibility, with protocol-aware receipt parsing and `SealevelCoreAdapter.parseMessageDispatchLogs` for Sealevel message ID extraction.
  - LiFi bridge extended with Sealevel support via `KeypairWalletAdapter`, Hyperlane domain ID to LiFi chain ID translation, and mutex around configure+execute to prevent race conditions.
  - Startup validation for signer coverage against all inventory route protocols, per-protocol address format validation, and Solana pubkey cross-check.
  - `parseSolanaPrivateKey()` utility with strict 64-byte validation and base58 normalization.
  - Zod schemas hardened for strategy configs, external bridges, and inventory signers with per-protocol address validation.
  - Private key redaction in log statements and EVM-only filtering for Explorer signer addresses.

### Patch Changes

- 354668e: SnapshotHelper was extracted for shared e2e snapshot reset with timeout/retry logic. blockTag was changed to use raw eth_blockNumber RPC to bypass stale provider cache. TestHelpers race condition in getFirstMonitorEvent() was fixed with a settled flag.
- Updated dependencies [f2620a1]
- Updated dependencies [f7ebf6c]
- Updated dependencies [8a6f742]
- Updated dependencies [b05e242]
- Updated dependencies [aee625c]
  - @hyperlane-xyz/sdk@27.0.0
  - @hyperlane-xyz/core@11.0.2
  - @hyperlane-xyz/metrics@0.2.1
  - @hyperlane-xyz/utils@27.0.0
  - @hyperlane-xyz/provider-sdk@3.0.1

## 26.0.0

### Patch Changes

- 279b714: Provider initialization in `RebalancerContextFactory.create()` was restricted to EVM chains only. Non-EVM warp route chains (e.g. StarkNet, Sealevel) are now skipped, preventing crashes from ethers v5 rejecting non-numeric chainIds.
- Updated dependencies [43255a9]
- Updated dependencies [06aacac]
- Updated dependencies [763a264]
- Updated dependencies [1d116d8]
  - @hyperlane-xyz/sdk@26.0.0
  - @hyperlane-xyz/utils@26.0.0
  - @hyperlane-xyz/provider-sdk@3.0.0
  - @hyperlane-xyz/metrics@0.2.0
  - @hyperlane-xyz/core@11.0.1

## 25.5.0

### Patch Changes

- Updated dependencies [e197331]
- Updated dependencies [c2304d3]
- Updated dependencies [cd1c28a]
- Updated dependencies [69b48fa]
- Updated dependencies [048df98]
- Updated dependencies [840fb33]
  - @hyperlane-xyz/provider-sdk@2.0.0
  - @hyperlane-xyz/sdk@25.5.0
  - @hyperlane-xyz/metrics@0.1.11
  - @hyperlane-xyz/utils@25.5.0
  - @hyperlane-xyz/core@11.0.1

## 3.2.1

### Patch Changes

- Updated dependencies [5a7efbb]
  - @hyperlane-xyz/sdk@25.4.1
  - @hyperlane-xyz/metrics@0.1.10
  - @hyperlane-xyz/utils@25.4.1
  - @hyperlane-xyz/provider-sdk@1.4.1
  - @hyperlane-xyz/core@11.0.1

## 3.2.0

### Minor Changes

- b50aa7b: Added ERC20 inventory rebalancing support with collateral token approval handling and comprehensive e2e tests.

### Patch Changes

- Updated dependencies [1f021bf]
- Updated dependencies [d4a5026]
- Updated dependencies [934d857]
- Updated dependencies [1f3a0e6]
- Updated dependencies [027eeac]
- Updated dependencies [942bbfb]
- Updated dependencies [a3f7fd3]
- Updated dependencies [2a6bd61]
- Updated dependencies [1f021bf]
  - @hyperlane-xyz/utils@25.4.0
  - @hyperlane-xyz/sdk@25.4.0
  - @hyperlane-xyz/core@11.0.1
  - @hyperlane-xyz/provider-sdk@1.4.0
  - @hyperlane-xyz/metrics@0.1.9

## 3.1.1

### Patch Changes

- Updated dependencies [521d42b]
  - @hyperlane-xyz/core@10.2.0
  - @hyperlane-xyz/metrics@0.1.8
  - @hyperlane-xyz/sdk@25.3.2
  - @hyperlane-xyz/utils@25.3.2
  - @hyperlane-xyz/provider-sdk@1.3.6

## 3.1.0

### Minor Changes

- aa6871b: Added configurable intent TTL to expire stale in-progress rebalance intents. Defaults to 7 days. Uses `send_occurred_at` from the explorer API for accurate TTL calculation.

### Patch Changes

- ff8c0f0: Fixed inventory rebalancer oscillation edge case where an intent with its final deposit fully in-flight (remaining === 0) was invisible to the rebalancer, potentially allowing contradictory intent creation.
  - @hyperlane-xyz/sdk@25.3.1
  - @hyperlane-xyz/metrics@0.1.7
  - @hyperlane-xyz/utils@25.3.1
  - @hyperlane-xyz/provider-sdk@1.3.5
  - @hyperlane-xyz/core@10.1.5

## 3.0.0

### Major Changes

- 1970a32: Added inventory rebalancing via external bridges (LiFi), enabling token rebalancing across chains where Hyperlane warp routes alone are insufficient. This is a breaking change to the config schema, type system, and tracking interfaces.

  ### Breaking: Config Schema
  - `RebalancerBridgeConfigSchema.bridge` changed from **required** to **optional** — inventory chains don't use on-chain bridge contracts
  - Added `executionType` field to chain config (`'movableCollateral' | 'inventory'`), defaults to `movableCollateral` for backward compatibility
  - Added `externalBridge` field to chain config (`'lifi'`) for specifying which external bridge to use
  - Added top-level `inventorySigner` field (required when any chain uses inventory execution)
  - Added top-level `externalBridges` config block with `LiFiBridgeConfigSchema` (`{ integrator, defaultSlippage? }`)
  - New Zod cross-field validations: `bridge` required for `movableCollateral` chains, `externalBridge` required for `inventory` chains, `inventorySigner` and `externalBridges.lifi` required when inventory chains exist

  ### Breaking: Route Types
  - **Deleted** `RebalanceRoute` type (was `StrategyRoute & { intentId }`)
  - **Deleted** `RebalanceExecutionResult` and `RebalanceMetrics` types
  - `StrategyRoute` changed from `Route & { bridge }` to discriminated union: `MovableCollateralRoute | InventoryRoute`, discriminated on `executionType`
  - Added `MovableCollateralRoute` (`{ executionType: 'movableCollateral', bridge }`) and `InventoryRoute` (`{ executionType: 'inventory', externalBridge }`)
  - Added `RouteWithContext` extending `Route` with `deliveredAmount` and `awaitingDeliveryAmount` for inventory intent tracking
  - `InflightContext.pendingRebalances` and `pendingTransfers` changed from `Route[]` to `RouteWithContext[]`

  ### Breaking: IRebalancer Interface
  - `IRebalancer` changed from non-generic `{ rebalance(routes: RebalanceRoute[]): Promise<RebalanceExecutionResult[]> }` to generic `IRebalancer<R extends Route, E extends ExecutionResult<R>>` with `rebalancerType` field
  - Added `ExecutionResult<R>` base type and specialized `MovableCollateralExecutionResult` / `InventoryExecutionResult`
  - Added `IMovableCollateralRebalancer` and `IInventoryRebalancer` type aliases
  - `PreparedTransaction.route` changed from `RebalanceRoute` to `MovableCollateralRoute & { intentId: string }`

  ### Breaking: IActionTracker Interface
  - `CreateRebalanceIntentParams`: added `executionMethod` and `externalBridge` fields
  - `CreateRebalanceActionParams`: added required `type: ActionType` field, `messageId` changed from required to optional, added `externalBridgeTransferId` and `externalBridgeId` fields
  - `RebalanceIntent`: removed `fulfilledAmount` field, added `executionMethod` and `externalBridge` fields
  - `RebalanceAction`: added required `type: ActionType` field, `messageId` changed from required to optional, added `externalBridgeTransferId` and `externalBridgeId` fields
  - New required methods on `IActionTracker`: `syncInventoryMovementActions()`, `getPartiallyFulfilledInventoryIntents()`, `getActionsByType()`, `getActionsForIntent()`, `getInflightInventoryMovements()`

  ### Breaking: Tracking Types
  - Added `ExecutionMethod` type (`'movable_collateral' | 'inventory'`)
  - Added `ActionType` type (`'rebalance_message' | 'inventory_movement' | 'inventory_deposit'`)
  - Added `PartialInventoryIntent` type for tracking partially fulfilled inventory intents

  ### Breaking: Public API Exports
  - Removed exports: `RebalanceRoute`, `RebalanceExecutionResult`
  - Added exports: `ExecutionResult`, `IInventoryRebalancer`, `IMovableCollateralRebalancer`, `InventoryExecutionResult`, `MovableCollateralExecutionResult`, `RebalancerType`, `InventoryRoute`, `MovableCollateralRoute`, `Route`, `ActionType`, `PartialInventoryIntent`, `isMovableCollateralConfig`, `isInventoryConfig`, `MovableCollateralBridgeConfig`, `InventoryBridgeConfig`

  ### New: InventoryRebalancer
  - `InventoryRebalancer` — implements `IInventoryRebalancer`, orchestrates external bridge transfers followed by `transferRemote` deposits
  - `IExternalBridge` interface with `quote()`, `execute()`, `getStatus()` methods and associated types (`BridgeQuoteParams`, `BridgeQuote`, `BridgeTransferResult`, `BridgeTransferStatus`)
  - `LiFiBridge` — LiFi SDK integration for route quoting, transaction execution, and status polling
  - `ExternalBridgeRegistry` — maps `ExternalBridgeType` to `IExternalBridge` implementations
  - `gasEstimation` utilities using viem `estimateGas` with configurable multiplier

  ### New: Integration
  - `RebalancerService` supports dual signing keys (`HYP_REBALANCER_KEY` + optional `HYP_INVENTORY_KEY`) with separate `MultiProvider` instances
  - `RebalancerContextFactory` expanded with `createRebalancers()` and bridge instance creation
  - `Monitor` extended with `InventoryMonitorConfig` and `fetchInventoryBalances()`
  - `RebalancerOrchestrator` dispatches routes to appropriate rebalancer via `Map<string, IRebalancer>` by type
  - Backward-compatible `HYP_KEY` fallback in service entry point

### Patch Changes

- 1970a32: Fixed inventory rebalancer to include tokenFeeQuote in transfer cost calculation, preventing UNPREDICTABLE_GAS_LIMIT failures when native token fees exceed tx gas costs.
- Updated dependencies [aea767c]
  - @hyperlane-xyz/sdk@25.3.0
  - @hyperlane-xyz/metrics@0.1.6
  - @hyperlane-xyz/utils@25.3.0
  - @hyperlane-xyz/provider-sdk@1.3.4
  - @hyperlane-xyz/core@10.1.5

## 2.0.0

### Major Changes

- c61d612: **Breaking**: `IActionTracker` interface was extended with new required query methods (`getTransfer`, `getRebalanceIntent`, `getRebalanceAction`, `getInProgressActions`) to support E2E test assertions against tracked state. External implementations of `IActionTracker` must implement these methods.

  Extracted `RebalancerOrchestrator` from `RebalancerService` to separate polling orchestration from service lifecycle, improving testability. Fixed non-null assertion pattern on metrics and tightened `executeWithTracking` return type to `void`.

  Added comprehensive E2E test harness with `TestRebalancer` builder, `ForkIndexer` for indexing Dispatch events from Anvil forks, and full E2E coverage for weighted, minAmount, collateral-deficit, and composite strategies.

### Minor Changes

- ccd638d: Improved shared RPC override handling across TypeScript services.

### Patch Changes

- Updated dependencies [215dff0]
- Updated dependencies [d2f75a1]
- Updated dependencies [360db52]
- Updated dependencies [18ec479]
- Updated dependencies [795d93e]
- Updated dependencies [e143956]
- Updated dependencies [ccd638d]
- Updated dependencies [c61d612]
- Updated dependencies [c2affe2]
  - @hyperlane-xyz/sdk@25.2.0
  - @hyperlane-xyz/utils@25.2.0
  - @hyperlane-xyz/metrics@0.1.5
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/provider-sdk@1.3.3

## 1.0.3

### Patch Changes

- Updated dependencies [b930534]
- Updated dependencies [a18d0e6]
  - @hyperlane-xyz/sdk@25.1.0
  - @hyperlane-xyz/utils@25.1.0
  - @hyperlane-xyz/metrics@0.1.4
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/provider-sdk@1.3.2

## 1.0.2

### Patch Changes

- Updated dependencies [52ce778]
- Updated dependencies [aaabbad]
  - @hyperlane-xyz/utils@25.0.0
  - @hyperlane-xyz/sdk@25.0.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/metrics@0.1.3
  - @hyperlane-xyz/provider-sdk@1.3.1

## 1.0.1

### Patch Changes

- 8c80288: ActionTracker now uses MultiProtocolCore instead of HyperlaneCore for message delivery checks, enabling support for all VM types. Registry addresses are validated at startup to ensure mailbox is present.
- Updated dependencies [57461b2]
- Updated dependencies [d580bb6]
- Updated dependencies [50868ce]
- Updated dependencies [b05e9f8]
- Updated dependencies [f44c2b4]
- Updated dependencies [9dc71fe]
- Updated dependencies [bde05e9]
- Updated dependencies [d0b8c24]
- Updated dependencies [4de5071]
  - @hyperlane-xyz/utils@24.0.0
  - @hyperlane-xyz/sdk@24.0.0
  - @hyperlane-xyz/provider-sdk@1.3.0
  - @hyperlane-xyz/core@10.1.5
  - @hyperlane-xyz/metrics@0.1.2

## 1.0.0

### Major Changes

- 0e1e48a: Inflight-aware rebalancing system with ActionTracker, new strategies, and type safety improvements.

  Breaking changes:
  - IRebalancer.rebalance() returned RebalanceExecutionResult[] instead of void
  - IStrategy.getRebalancingRoutes() accepted optional inflightContext parameter
  - IStrategy required a name property
  - RebalancingRoute renamed to StrategyRoute with required bridge field
  - MonitorEvent included confirmedBlockTags for confirmed block queries

  New features:
  - ActionTracker for tracking pending transfers and rebalance actions with Explorer integration
  - CollateralDeficitStrategy for just-in-time rebalancing based on pending inbound transfers
  - CompositeStrategy for chaining multiple strategies with coordination
  - BaseStrategy inflight-aware methods: reserveCollateral(), getAvailableBalance()
  - Query balances at confirmed blocks to sync with Explorer indexing
  - Strategy config supports array format for composing multiple strategies (backwards compatible)

  Bug fixes:
  - Record failure metrics when rebalance results contain failures
  - Treat missing Dispatch event as rebalance failure
  - Fix CompositeStrategy oscillation by separating proposed from pending rebalances

### Minor Changes

- 8ad7e65: Implemented ActionTracker for inflight-message-aware rebalancing. The ActionTracker tracked three entity types: user warp transfers (Transfer), rebalance intents (RebalanceIntent), and rebalance actions (RebalanceAction). It provided startup recovery by querying the Explorer for inflight messages, periodic sync operations to check message delivery status on-chain, and a complete API for creating and managing rebalance intents and actions. The implementation included a generic store interface (IStore) with an InMemoryStore implementation, comprehensive unit tests, and integration with ExplorerClient for querying inflight messages.
- 3bd911e: Added CollateralDeficitStrategy for just-in-time rebalancing. This strategy detected collateral deficits (negative effective balances from pending user transfers) and proposed fast rebalances using configured bridges. Modified reserveCollateral() to allow negative values for deficit detection.
- 16ff4a9: Added CompositeStrategy for chaining multiple rebalancing strategies. Routes from earlier strategies were passed as pending rebalances to later strategies for coordination. Strategy config used array format - single strategy is an array with 1 element. Also unified schema types by making bridgeLockTime optional and added name property to IStrategy interface for better logging.
- 96eba9b: BaseStrategy is extended with inflight-aware rebalancing capabilities and bridge configuration support. RebalancingRoute extended with optional bridge field for bridge selection. Added three protected methods: reserveCollateral() to prevent draining collateral needed for incoming transfers, simulatePendingRebalances() for optional balance simulation, and filterRebalances() to filter routes based on actual balance sufficiency. The getRebalancingRoutes() method updated to accept optional inflightContext and integrate the new methods. getCategorizedBalances() signature updated to accept optional pendingRebalances parameter. BaseStrategy, WeightedStrategy, and MinAmountStrategy constructors extended with optional bridges parameter (ChainMap<Address[]>) to store configured bridge addresses per chain.

### Patch Changes

- Updated dependencies [d1d90d2]
- Updated dependencies [52fd0f8]
- Updated dependencies [7c22cff]
- Updated dependencies [0b8c4ea]
- Updated dependencies [52fd0f8]
- Updated dependencies [52fd0f8]
- Updated dependencies [a10cfc8]
- Updated dependencies [6ddef74]
- Updated dependencies [80f3635]
- Updated dependencies [576cd95]
- Updated dependencies [9aa93f4]
- Updated dependencies [42b72c3]
- Updated dependencies [a5d6cae]
  - @hyperlane-xyz/sdk@23.0.0
  - @hyperlane-xyz/provider-sdk@1.2.1
  - @hyperlane-xyz/utils@23.0.0
  - @hyperlane-xyz/metrics@0.1.1
  - @hyperlane-xyz/core@10.1.5

## 0.1.2

### Patch Changes

- b892d63: Migrated to use shared utilities from `@hyperlane-xyz/metrics` package, eliminating duplicate metric server implementations and ensuring consistent Prometheus metric collection across all services.
- 66ef635: Added `mapAllSettled` helper to @hyperlane-xyz/utils for typed parallel operations with key-based error tracking. Migrated Promise.allSettled patterns across sdk, cli, infra, and rebalancer packages to use the new helper.
- 223fd7f: Suppressed harmless startup warnings via pnpm patches instead of runtime suppression. The bigint-buffer native bindings warning and node-fetch .data deprecation warning are now patched at the source, avoiding the need for --no-warnings flags or console.warn overrides.
- Updated dependencies [c6a6d5f]
- Updated dependencies [4c58992]
- Updated dependencies [99948bc]
- Updated dependencies [99948bc]
- Updated dependencies [b0e9d48]
- Updated dependencies [66ef635]
- Updated dependencies [7f31d77]
- Updated dependencies [7a0a9e4]
- Updated dependencies [3aec1c4]
- Updated dependencies [b892d63]
  - @hyperlane-xyz/sdk@22.0.0
  - @hyperlane-xyz/utils@22.0.0
  - @hyperlane-xyz/provider-sdk@1.2.0
  - @hyperlane-xyz/metrics@0.1.0
  - @hyperlane-xyz/core@10.1.5

## 0.1.1

### Patch Changes

- Updated dependencies [57a2053]
  - @hyperlane-xyz/provider-sdk@1.1.0
  - @hyperlane-xyz/sdk@21.1.0
  - @hyperlane-xyz/utils@21.1.0
  - @hyperlane-xyz/core@10.1.5

## 0.1.0

### Minor Changes

- bc8b22f: Moved rebalancer-specific type definitions from `@hyperlane-xyz/sdk` to `@hyperlane-xyz/rebalancer`. Updated CLI and infra imports to use the new location. The rebalancer package is now self-contained and doesn't pollute the SDK with rebalancer-specific types.
- 9963e0e: feat: separate rebalancer package
  - Extract rebalancer logic from CLI into dedicated `@hyperlane-xyz/rebalancer` package
  - New package supports both manual CLI execution and continuous daemon mode for K8s deployments
  - CLI now imports from new package, maintaining backward compatibility for manual rebalancing

### Patch Changes

- Updated dependencies [c08fa32]
- Updated dependencies [68310db]
- Updated dependencies [b6b206d]
- Updated dependencies [239e1a1]
- Updated dependencies [bc8b22f]
- Updated dependencies [ed10fc1]
- Updated dependencies [0bce4e7]
  - @hyperlane-xyz/sdk@21.0.0
  - @hyperlane-xyz/provider-sdk@1.0.0
  - @hyperlane-xyz/utils@21.0.0
  - @hyperlane-xyz/core@10.1.4
