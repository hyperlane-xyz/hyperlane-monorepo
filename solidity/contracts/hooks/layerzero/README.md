# LayerZero V2 Hook/ISM

The LayerZero V2 Hook/ISM uses a configured LayerZero pathway to authenticate
Hyperlane messages. A deployment is both:

- an origin post-dispatch hook that sends the Hyperlane message ID through
  LayerZero; and
- a destination interchain security module (ISM) that requires LayerZero to
  authenticate that same message ID.

Each local deployment can serve multiple enrolled remote domains. Applications
can share one deployment when they accept its owner, peer set, LayerZero
libraries, DVN configuration, and operational blast radius. Separate
deployments provide independent policy and ownership.

[`LayerZeroV2HookIsm`](./LayerZeroV2HookIsm.sol) verifies a
LayerZero packet during `Mailbox.process`. Its ISM metadata ABI-encodes
`(address receiveLibrary, bytes encodedPacket)`.

The Hyperlane delivery transaction can commit a packet after the configured
DVNs attest. Verification requires an offchain lookup packet service, but does not
wait for LayerZero Executor delivery. The Hyperlane relayer cannot replace the
DVNs' attestations.

## LayerZero terms used here

An [Endpoint V2](https://docs.layerzero.network/v2/developers/evm/protocol-contracts-overview)
is LayerZero's on-chain entry point on each chain. An endpoint ID identifies a
LayerZero chain; it is distinct from a Hyperlane domain ID. This hook/ISM is the
LayerZero application (OApp) on both sides of a pathway.

For a message from A to B:

1. A's Endpoint uses the selected
   [send library](https://docs.layerzero.network/v2/concepts/protocol/message-send-library)
   to encode the packet, quote the fee, and assign work to the configured DVNs
   and Executor. `executorConfig` holds its outbound Executor settings for B's
   endpoint ID, and `sendUlnConfig` holds the DVN and confirmation requirements
   it assigns.
2. DVNs submit packet attestations to B's selected
   [receive library](https://docs.layerzero.network/v2/concepts/protocol/message-receive-library).
   `receiveUlnConfig` holds the DVN and confirmation requirements the receive
   library checks. Once those requirements are met, anyone can call
   the receive library's `commitVerification`; it records the packet's payload
   hash in B's Endpoint.
3. A configured Executor normally submits the verified packet to
   `Endpoint.lzReceive`, but the Endpoint does not restrict that call to the
   configured Executor; anyone can submit it. Here, the Hyperlane relayer
   instead supplies the packet during `Mailbox.process`. The ISM checks the exact
   packet and commits verification if needed. Executor delivery is not
   required for Hyperlane processing.

Selecting a library and setting its configuration are different Endpoint
operations. A library address chooses the implementation for this OApp and
remote endpoint ID; `setConfig` supplies that library's worker policy. All-zero
configuration structs use the selected ULN302 libraries' defaults. Those
defaults are mutable and controlled by each message library's owner, so using
them extends the route's trust assumptions to that governance. The hook/ISM
owner must check that the send policy on A and receive policy on B are
compatible. See LayerZero's
[pathway configuration guide](https://docs.layerzero.network/v2/get-started/create-lz-oapp/configuring-pathways).

This pull verifier decodes Endpoint V2 PacketV1 data and calls
`IReceiveUlnE2.commitVerification` for packets not already committed. Select
compatible message libraries; Endpoint registration alone does not establish
that a receive library supports this interface.

## Hyperlane integration

The origin Mailbox normally invokes the deployment as a post-dispatch hook. The
hook sends a versioned payload containing the Hyperlane origin, destination,
and message ID through the local LayerZero Endpoint. On the destination, the
recipient selects the corresponding deployment as its ISM, directly or through
a routing or aggregation ISM.

```mermaid
flowchart LR
    subgraph A[Origin domain]
        AppA[Application] --> MailboxA[Mailbox]
        MailboxA -->|postDispatch| LzA[LayerZero Hook/ISM]
        LzA --> EndpointA[LayerZero Endpoint]
    end
    EndpointA -->|packet authenticated by configured pathway| EndpointB[LayerZero Endpoint]
    subgraph B[Destination domain]
        EndpointB --> LzB[LayerZero Hook/ISM]
        Relayer[Hyperlane relayer] --> MailboxB[Mailbox]
        MailboxB -->|verify| LzB
        MailboxB --> Recipient[Recipient]
    end
```

The LayerZero packet carries only an authentication payload. It does not carry
the full Hyperlane message and does not call the Hyperlane recipient. A
Hyperlane relayer must still submit the original message to `Mailbox.process`.

The payload is defined by
[`LayerZeroMessage.sol`](../../libs/LayerZeroMessage.sol) and packs:

```text
version = 1
Hyperlane origin domain
Hyperlane destination domain
Hyperlane message ID
```

The message ID commits to the complete packed Hyperlane message, including its
nonce, sender, recipient, body, origin, and destination. Verification requires
the exact enrolled LayerZero peer and endpoint ID for that origin.

For traffic from A to B, configure both sides:

1. A's hook tree invokes A's LayerZero deployment.
2. A enrolls B's LayerZero deployment as the destination peer.
3. B's recipient selects B's deployment in its ISM policy.
4. B enrolls A's LayerZero deployment as the authenticated origin peer.
5. Both LayerZero pathways use the intended libraries, DVNs, confirmations,
   and Executor configuration.

The Mailbox runs its required hook and either the caller-selected or default
hook. Invoking the same LayerZero deployment twice for one dispatch causes the
second call to revert with `LayerZeroAuthorizationAlreadySent` and rolls back
the dispatch.

`postDispatch` is permissionless, but it accepts only the Mailbox's latest
dispatched message and only once per message ID. This permits recovery when the
hook was omitted from a dispatch, while the message remains the latest
dispatch. Normal integrations should invoke the hook atomically during
dispatch instead of depending on this timing-sensitive recovery path.

The hook stores only the latest published authorization ID. Once a later
message is dispatched, the Mailbox's latest-ID check prevents republishing an
older message. Repeating the hook within one dispatch is rejected by the stored
ID.

## Offchain lookup verification

The ISM obtains the exact encoded LayerZero packet through EIP-3668
offchain lookup. A compatible service implements
`getLayerZeroPacket(bytes hyperlaneMessage)` and returns the ABI encoding of:

```solidity
(address receiveLibrary, bytes encodedPacket)
```

The configured URL is a discovery and transport service. It is not trusted for
authenticity. The contract rejects noncanonical metadata, packets over 4096
bytes, malformed packet encoding, and mismatches in every authenticated field.

```mermaid
sequenceDiagram
    participant Relayer
    participant Service as Offchain lookup packet service
    participant Mailbox
    participant Ism as Offchain lookup Hook/ISM
    participant Library as Receive library
    participant Endpoint
    participant Recipient

    Relayer->>Ism: getOffchainVerifyInfo(message)
    Ism-->>Relayer: OffchainLookup(urls, calldata)
    Relayer->>Service: getLayerZeroPacket(message)
    Service-->>Relayer: ABI(receiveLibrary, encodedPacket)
    Relayer->>Mailbox: process(metadata, message)
    Mailbox->>Ism: verify(metadata, message)
    Ism->>Ism: validate packet, route, payload, and GUID
    alt payload hash is not committed
        Ism->>Library: commitVerification(header, payloadHash)
        Library->>Endpoint: verify(origin, receiver, payloadHash)
    end
    Ism-->>Mailbox: true
    Mailbox->>Recipient: handle(message)
```

The Endpoint may already hold a packet's DVN-verified payload hash before
Hyperlane delivery. In that case, `verify` compares the stored hash with this
packet's hash and does not call the receive library again. A packet committed
before a receive-library rotation therefore remains valid even if its old
library is no longer selected. ULN302 deletes the DVN attestations used for a
commitment, so a second `commitVerification` call without fresh attestations
reverts. Checking the stored hash avoids that call. If the Endpoint has no
hash, `verify` requires the metadata-supplied receive library to be currently
valid and asks it to commit verification. A different stored hash reverts with
`ConflictingPayloadHash`.

`verify` never clears the stored hash. It is therefore idempotent: it can be
called repeatedly, outside `Mailbox.process`, and more than once for the same
message, including when one deployment appears several times in an ISM tree.

The hook sends a one-gas `lzReceive` option because standard LayerZero
Executors reject missing and zero-gas receive options. Normal Executor callback
delivery cannot complete with that budget. Neither direct verification nor
`Mailbox.process` clears the payload hash from the Endpoint.

## Fees

`quoteDispatch` asks the Endpoint for the current native fee. The send library
calculates that quote using the configured DVN and Executor fees.

DVNs are independent verifiers that observe packets and submit attestations to
the receive library. Their attestations are not produced by Hyperlane
validators and are not paid by the Hyperlane Mailbox. The LayerZero send fee is
needed because the packet must enter LayerZero's configured security and
delivery system before the destination Endpoint can accept its payload hash.
Paying the fee does not let the sender choose a different DVN threshold or make
an invalid packet pass verification; those rules come from the configured
message libraries and DVN settings.

The quote still includes the minimum one-gas Executor option required for a
standard pathway to quote and send. It may therefore pay an Executor component
even though Hyperlane delivery does not rely on successful Executor execution.

These fees are separate from:

- origin transaction gas;
- Hyperlane relayer or interchain gas payment costs; and
- gas for `Mailbox.process` and recipient execution.

Only native-fee LayerZero Endpoints are supported. The constructor rejects an
Endpoint whose `nativeToken()` is nonzero. Hook metadata with an ERC-20 fee
token is rejected, and the LayerZero send always sets `payInLzToken` to false.
The hook ignores metadata destination `msgValue` because hook aggregations pass
the same metadata to every child; this hook's Executor option always specifies
zero destination native value.

`quoteDispatch` is a point-in-time quote. During `postDispatch`, the Endpoint
calculates the current fee and reverts an underpaid dispatch. It returns excess
payment to the hook metadata's refund address, or the Hyperlane sender when no
explicit refund address is supplied. A refund failure reverts the dispatch.

All children of a hook aggregation receive the same metadata. An aggregation
containing this native-only hook cannot simultaneously use a nonzero ERC-20 fee
token for another child.

## Route and Endpoint configuration

Construction fixes three values permanently: the Hyperlane Mailbox, LayerZero
Endpoint, and local endpoint ID. Constructor checks confirm that the Endpoint
has code, reports a nonzero endpoint ID, and uses the native currency fee model.
These checks do not prove that the configured contracts and identifiers are
canonical for the chain; the deployer must verify them.

Rich enrollment configures a route atomically with:

- Hyperlane remote domain;
- exact remote Hook/ISM address;
- LayerZero remote endpoint ID;
- explicit send and receive libraries;
- separate send and receive ULN policies; and
- one outbound Executor policy.

Enrollment rejects the local domain, zero/local endpoint IDs, a zero peer, and
reuse of one endpoint ID by multiple Hyperlane domains. Peers are arbitrary
nonzero `bytes32` values, as LayerZero also supports non-EVM addresses. A route
is accepted only after its send and receive libraries are selected explicitly
for this OApp, rather than inheriting the Endpoint's mutable library defaults.

The inherited basic `Router.enrollRemoteRouter` path is disabled because it
cannot install the required LayerZero policy. Use the typed
`enrollRemoteRouters` function on the concrete contract. Batch operations are
atomic.

Calling rich enrollment for an existing domain replaces its route in one
transaction. The contract sets the supplied peer, endpoint ID, libraries, and
policy directly. It writes the Executor and send ULN config types to the send
library and the receive ULN config type to the receive library, using the
selected library's default for an all-zero config rather than retaining its old
value. ULN302 libraries are send-only or receive-only and the Endpoint rejects a
library selected in the wrong direction, so the two writes do not overlap.
If the endpoint ID changes, the old Endpoint path is blocked and its reverse
lookup removed. No old library config is reset during overwrite: it is inactive
once deselected, and a later selection writes a complete policy. If any step
fails, the old route remains unchanged. A config-only change uses this same
overwrite operation without a between-transaction gap. Packets committed by
the Endpoint remain verifiable if the peer and endpoint ID are unchanged.
Uncommitted packets may no longer verify after a peer, endpoint ID, or
receive-library change. Changing only the receive DVNs or confirmation count
can also strand uncommitted packets: the receive library checks them against
the current policy, even when its address is unchanged. Receive-library
rotation uses zero grace so the previous library becomes invalid immediately.
Operators should drain in-flight packets before rotating or ensure DVNs
re-attest them through the replacement library.

Endpoint configuration is directional. A to B and B to A may use different
libraries, DVNs, confirmation counts, and Executors, and within one deployment
the send and receive ULN policies are independent. For each direction, the
origin's `sendUlnConfig` must assign DVNs and a confirmation count that satisfy
the destination's `receiveUlnConfig`; otherwise packets stay pending until the
policies are corrected. A LayerZero endpoint ID is not an EVM chain ID or
Hyperlane domain:

```text
EVM chain ID != Hyperlane domain != LayerZero endpoint ID
```

Owner compromise is security-critical. The owner can replace trusted peers and
change the libraries and DVN policy used by the Endpoint for this OApp.

## Authentication and trust boundary

Destination authentication checks bind together:

1. the immutable destination Endpoint and local endpoint ID;
2. the enrolled source endpoint ID and exact remote peer;
3. the destination Hook/ISM address in the LayerZero packet;
4. the LayerZero nonce and recomputed GUID;
5. the versioned payload's Hyperlane origin and destination; and
6. the full Hyperlane message ID.

GUID validation hashes the complete 32-byte LayerZero sender, including any
non-EVM address bytes.

| Component                                                 | Security role                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| LayerZero Endpoint and selected message libraries         | Commit and expose authenticated packet state according to the configured pathway                             |
| Message-library owner, when library defaults are selected | Can change the default DVN, confirmation, or Executor policy inherited by an all-zero configuration          |
| Configured DVNs                                           | Attest packets under the configured threshold and confirmation policy                                        |
| Hook/ISM owner                                            | Select peers, endpoint IDs, libraries, DVNs, confirmations, and Executor policy                              |
| Hyperlane Mailbox                                         | Supplies the canonical message and final replay protection                                                   |
| Application configuration                                 | Ensures this hook runs on dispatch and this ISM participates in delivery policy                              |
| Executor, offchain lookup service, and Hyperlane relayer  | Transport data and transactions; can delay or omit work but cannot satisfy packet checks with different data |

A matching LayerZero packet proves that the enrolled remote Hook/ISM sent an
authorization for the exact Hyperlane message ID. It does not prove that the
message's Hyperlane sender is an application the recipient intended to trust.
Recipients must validate `(origin, sender)` in `handle`, as Hyperlane `Router`
does, or enforce an equivalent application/ISM policy.

## Message and route lifecycle

Origin dispatch and LayerZero send are atomic when the Hook/ISM is in the hook
tree. A failed quote, send, or refund reverts the Mailbox dispatch and the
latest published authorization ID write. DVN attestation and destination
processing occur asynchronously.

Route changes affect in-flight messages by stage:

| Stage                                            | Effect of route or receive-policy changes                                                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Before origin publication                        | Later sends require the new route                                                                                                  |
| Packet sent but not authenticated at destination | Destination checks use the current endpoint ID, peer, library, and DVN/confirmation policy; old packets may no longer authenticate |
| Pull packet awaiting `Mailbox.process`           | Verification uses current route identity; old peer or endpoint ID data is rejected                                                 |
| Hyperlane message delivered                      | Mailbox replay protection remains final                                                                                            |

Unenrollment removes the peer and endpoint ID mappings and blocks both Endpoint
directions. Inactive library configuration remains stored; every later
enrollment replaces it completely.

## Pull packet cleanup and LayerZero nonces

LayerZero assigns a `uint64` nonce per source/destination OApp channel.
Returning zero from `nextNonce` opts out of application-level ordered execution;
it does not disable Endpoint nonce accounting. To advance its lazy inbound
nonce, `Endpoint.clear` checks that every intervening nonce has a verified
payload hash. This prevents a clear from skipping an unverified packet, even
though packets can be verified and executed out of order.

`verify` only commits the payload hash; it never calls `Endpoint.clear`. The
Endpoint keeps the hash and its lazy inbound nonce does not advance until
someone clears the packet. Hyperlane delivery does not read either: the Mailbox
delivery record is the replay guard, and the packet commits to the Hyperlane
message ID.

After Mailbox delivery, any caller can invoke the normal LayerZero Endpoint
`lzReceive` path for that exact packet with sufficient gas. The Endpoint clears
first and calls this contract's `lzReceive`; the callback accepts only delivered
message IDs. Before Mailbox delivery, that callback reverts and atomically rolls
back the Endpoint clear. Because the hook requests only one gas for Executor
delivery, operators that need Endpoint cleanup should submit it separately.

Cleanup is optional and does not affect Hyperlane verification or delivery.
Each clear walks every nonce from the lazy inbound nonce through the cleared
one, so clearing packets in nonce order keeps each call cheap. A nonce whose
packet was never committed, such as a message dispatched through this hook to a
recipient that does not use this ISM, makes clears of later nonces revert until
that packet is committed.

## Observability

| Event                                                               | Meaning                                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------- |
| Mailbox `DispatchId`                                                | Origin Mailbox emitted the Hyperlane message ID                 |
| `LayerZeroAuthorizationSent`                                        | Origin Hook/ISM paid the Endpoint and obtained a GUID and nonce |
| LayerZero Endpoint `PacketSent`                                     | Endpoint emitted the complete encoded packet                    |
| `LayerZeroPayloadVerified`                                          | ISM matched or committed the exact Endpoint payload hash        |
| Mailbox `ProcessId`                                                 | ISM verification and recipient handling completed               |
| `LayerZeroRemoteRouterEnrolled` / `LayerZeroRemoteRouterUnenrolled` | Owner changed route identity                                    |
| `LayerZeroSendLibrarySet` / `LayerZeroReceiveLibrarySet`            | Owner selected an Endpoint library                              |
| Library `UlnConfigSet` / `ExecutorConfigSet`                        | Owner changed pathway worker configuration                      |

`LayerZeroPayloadVerified` does not report the metadata-supplied receive
library. When a payload hash was committed before processing, that library is
not consulted and is not authenticated event data.

## Operational constraints

- The contract targets Ethereum-protocol chains and Tron with LayerZero V2
  Endpoint support.
- Non-EVM peers require a compatible remote Hook/ISM implementation.
- Only native-fee Endpoints are supported.
- The ISM requires an offchain-lookup-compatible relayer and packet service.
- The contract does not fund Hyperlane relaying; configure an IGP or other
  delivery mechanism separately when needed.
- `Router.handle` is unsupported because LayerZero transports authorization,
  not application message bodies.
