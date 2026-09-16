# Wormhole Hook/ISM

`WormholeVaaHookIsm` is a combined Hyperlane post-dispatch hook and interchain
security module (ISM). It uses Wormhole Guardian attestations to authenticate
Hyperlane messages without asking Wormhole to execute the destination message.

Deploy one contract on each participating chain and configure that address as:

- the application's hook when sending; and
- the application's ISM when receiving.

One deployment can serve multiple remote Hyperlane domains when they share the
same owner, local consistency level, and CCIP-read URLs. Each remote route
retains its own expected consistency level.

## Message flow

On the origin chain:

1. `Mailbox.dispatch` constructs the Hyperlane message.
2. The Mailbox invokes `postDispatch(metadata, message)`.
3. The hook publishes a fixed-size commitment through the local Wormhole Core
   contract.
4. Wormhole Guardians observe the Core event, wait for the configured
   consistency level, and produce a signed VAA.

On the destination chain:

1. A CCIP-read-compatible Hyperlane relayer calls
   `getOffchainVerifyInfo(message)`.
2. The returned `OffchainLookup` data directs it to the configured VAA service.
3. The relayer supplies the service response as ISM metadata to
   `Mailbox.process`.
4. `verify(metadata, message)` verifies the VAA through the local Wormhole Core
   contract and compares it with the Hyperlane message.

The VAA service transports evidence only. It is not trusted: malformed,
unsigned, or mismatched VAAs fail onchain verification.

## Published commitment

The Wormhole payload commits to:

- a Hyperlane/Wormhole protocol identifier and version;
- Hyperlane origin and destination domains;
- the destination `WormholeVaaHookIsm` address;
- the complete Hyperlane message ID; and
- the Hyperlane nonce.

The encoding is defined in
[`WormholeMessage.sol`](../../libs/WormholeMessage.sol).

Wormhole Core independently assigns a sequence to every publication from this
contract. The sequence locates the VAA but does not authorize a Hyperlane
message by itself. Hyperlane messages remain unordered: verification does not
require earlier nonces or Wormhole sequences to have been delivered.

## Authentication checks

`verify` accepts a VAA only when all of the following hold:

- Wormhole Core validates its Guardian signatures and Guardian set;
- the payload targets the local Hyperlane domain ID and this contract;
- the VAA nonce equals the nonce committed in the payload;
- the claimed Hyperlane origin has an enrolled remote hook/ISM;
- the VAA emitter chain equals that route's Wormhole chain ID;
- the VAA emitter address equals the enrolled remote hook/ISM address;
- the VAA consistency level equals the route's expected level; and
- the payload's origin, destination, message ID, and nonce equal the Hyperlane
  message passed to `verify`.

The destination Mailbox provides message replay protection. The ISM therefore
does not consume the VAA or maintain destination authorization state.

A matching VAA proves that the enrolled remote hook/ISM published the exact
Hyperlane message. It does not prove that the message's Hyperlane sender is an
application the recipient intended to authorize: any account can dispatch
through a canonical Mailbox and select a shared hook. A recipient using this
contract directly as its ISM must still validate the expected `(origin, sender)`
in `handle`, or enforce an equivalent application or ISM policy.

## Remote enrollment

Every remote hook/ISM route is enrolled atomically with:

| Field                      | Purpose                                               |
| -------------------------- | ----------------------------------------------------- |
| `domainId`                 | Hyperlane origin or destination domain ID             |
| `domainIsm`                | Remote combined hook/ISM address encoded as `bytes32` |
| `wormholeChainId`          | Wormhole chain containing that remote hook/ISM        |
| `expectedConsistencyLevel` | Required consistency level in VAAs from that hook/ISM |

The inherited `Router.routers(domainId)` mapping stores the remote hook/ISM as
the expected VAA emitter. `remoteRouterConfigs` stores its Wormhole chain ID and
expected consistency level. Verification requires both parts to match.

A Wormhole chain ID can belong to only one enrolled Hyperlane domain ID. The
`wormholeChainEnrollments` reverse lookup records this relationship explicitly,
including Hyperlane domain ID zero.

Changing a route's hook/ISM address or expected consistency level is allowed in
place. The change takes effect immediately, so VAAs issued under the previous
route configuration become invalid. Operators should account for in-flight
messages before updating or unenrolling a route. Changing its Wormhole chain ID
requires unenrollment first so both sides of the reverse index remain
consistent. The inherited address-only enrollment methods revert because they
cannot install a complete Wormhole policy.

Enrollment and unenrollment are owner-only. They immediately change which
future VAAs the ISM accepts. Applications sharing one deployment therefore also
share its owner and route-change blast radius.

## Consistency level

The constructor fixes the consistency level used for local Core publications.
Standard Wormhole EVM levels require no additional configuration.

The contract currently allows `0`, `1`, `200`, `201`, `202`, and `203`.
Wormhole's [consistency-level reference][wormhole-finality] documents `0` as
finalized on many chains. Its Solidity SDK defines `1` as finalized, while its
Guardian implementation uses `202` as an explicit EVM finalized sentinel. This
is a contract-specific allowlist, not proof that every value is supported on
every chain.

Consistency levels trade publication latency for protection against source-chain
reorganizations. Named `instant` and `safe` modes can produce VAAs sooner with
weaker reorg protection than `finalized`. A custom level follows its configured
base level and additional block delay, so its numeric value does not order its
latency or security. Supported levels and their precise meaning are
chain-specific and must be confirmed against Wormhole's [per-chain consistency
level table][wormhole-finality]. This contract's allowlist does not prove that
a chain supports safe or custom handling. Deployment tooling must validate
support and, for custom consistency, the official local CCL address.

Custom consistency uses Wormhole's Custom Consistency Level (CCL) contract. The
constructor receives:

- `customConsistencyLevelContract`: the local CCL contract address;
- `baseConsistencyLevel`: the underlying standard EVM consistency level; and
- `additionalBlocks`: the extra blocks to wait.

The deployer must verify that the supplied address is the official CCL contract
for the source chain.

The local consistency level and each remote route's expected consistency level
are separate: the former controls VAAs emitted here, while the latter controls
VAAs accepted from that remote hook/ISM.

## Fees and refunds

`quoteDispatch` returns the local Wormhole Core `messageFee()`. The hook accepts
that fee only in the chain's native token and rejects metadata selecting an
ERC-20 fee token.

`postDispatch` requires at least the current Core fee, publishes once, and
refunds only the excess supplied by that call to the metadata refund address.
Native tokens forced into the contract are never swept as part of a refund.

Publication is permissionless. If dispatch omitted this hook, any party may
call `postDispatch` for that still-unpublished message and pay the Core fee
while it remains the Mailbox's latest dispatch. A later successful dispatch
closes this rescue window. The caller cannot fabricate a message because the
hook checks its ID against the Mailbox, and each message can be published only
once by this deployment.

The hook publishes only the Mailbox's latest dispatched message and records
published message IDs. This prevents duplicate publication through the same
deployment. Applications should still ensure the same hook is not included
twice in nested required/default/aggregation hook trees, because the second
invocation reverts the dispatch.

## CCIP-read service

Owners configure one or more service URLs with `setUrls`. A compatible service
implements:

```solidity
getWormholeVaa(bytes message) returns (bytes encodedVaa)
```

The HTTP response is JSON `{ "data": "0x..." }`. `data` is the ABI encoding of
the function's single dynamic `bytes` return value, not the raw VAA. Metadata
supplied directly to `Mailbox.process` must use the same `abi.encode(encodedVaa)`
shape.

A URL containing `{data}` is queried by substituting the encoded service
calldata. Other URLs use the CCIP-read POST format. Multiple URLs provide
discovery fallback, but the relayer or service may cache results.

Service downtime affects automated delivery, not authentication. Any party that
obtains the canonical VAA can submit correctly encoded metadata.

## Deployment checks

Construction verifies that Wormhole Core:

- is a contract;
- reports the current EVM chain ID; and
- reports a nonzero Wormhole chain ID.

These checks do not prove an address is an official deployment. Deployment
tooling and reviewers must confirm the canonical Hyperlane Mailbox, Wormhole
Core, and optional CCL addresses for the chain.

[wormhole-finality]: https://wormhole.com/docs/products/reference/consistency-levels/
