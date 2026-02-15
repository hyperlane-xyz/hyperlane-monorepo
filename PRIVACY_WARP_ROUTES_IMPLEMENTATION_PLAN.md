# Privacy Warp Routes Implementation Plan

**Version**: 1.0
**Date**: 2026-02-11
**Status**: Ready for Implementation

---

## Executive Summary

This document outlines the complete implementation plan for **Privacy Warp Routes** - a privacy-enhanced token bridging system that uses Aleo blockchain as a middleware layer to break on-chain linkability between senders and recipients across any Hyperlane-supported chains.

**Key Features**:

- 🔒 **Sender-Recipient Unlinkability**: No deterministic on-chain link between original sender and final recipient
- 🎭 **Amount Privacy on Aleo**: Transfer amounts hidden in encrypted records during transit through Aleo
- 🔐 **Commitment-Based Security**: Cryptographic commitments prevent unauthorized forwarding and replay attacks
- 🌐 **Universal VM Support**: Works with all Hyperlane-supported chains (EVM, Cosmos, Solana, etc.)
- 💰 **All Token Types**: Supports native tokens, ERC20 collateral, and synthetic tokens
- ⚖️ **Movable Collateral**: Built-in rebalancing to prevent stuck transfers
- 🎯 **User-Controlled Timing**: Senders control forwarding timing for enhanced privacy
- 🔑 **Self-Custody**: Full user control via Aleo wallet registration (no custodians)

**Timeline**: 13 weeks from start to mainnet launch

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Security Model](#2-security-model)
3. [Technical Specifications](#3-technical-specifications)
4. [Implementation Phases](#4-implementation-phases)
5. [Testing Strategy](#5-testing-strategy)
6. [Deployment Plan](#6-deployment-plan)
7. [Risk Assessment](#7-risk-assessment)
8. [Appendices](#8-appendices)

---

## 1. System Architecture

### 1.1 High-Level Design

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          PRIVACY WARP ROUTE                              │
│                                                                           │
│  Origin Chain → Aleo Privacy Hub → Destination Chain                    │
│  (Public)        (Amount Hidden)      (Public)                          │
│                                                                           │
│  ✅ Sender visible on origin                                             │
│  ✅ Recipient visible on destination                                     │
│  ❌ NO linkable connection between them                                  │
└─────────────────────────────────────────────────────────────────────────┘

┌──────────────────┐         ┌──────────────────┐         ┌────────────────┐
│  Chain A         │         │  Aleo Privacy    │         │  Chain B       │
│  HypPrivate      │────────>│      Hub         │────────>│  HypPrivate    │
│                  │         │                  │         │                │
│ • Send to Aleo   │         │ • Private Records│         │ • Receive from │
│ • Receive from   │         │ • Hide Amounts   │         │   Aleo         │
│   Aleo           │         │ • Verify         │         │ • Send to Aleo │
│                  │         │   Commitments    │         │                │
│ Single contract  │         │ • Sender-        │         │ Single contract│
│ per chain        │         │   controlled     │         │ per chain      │
│                  │         │   timing         │         │                │
└──────────────────┘         └──────────────────┘         └────────────────┘
```

### 1.2 Core Components

#### **A. Chain Contracts** (Bidirectional)

Each supported chain deploys ONE contract that can both:

- **Send** tokens to Aleo privacy hub (deposit)
- **Receive** tokens from Aleo privacy hub (handle)

**Contract Variants by Token Type**:

- `HypPrivateNative` - Native blockchain tokens (ETH, MATIC, AVAX, etc.)
- `HypPrivateCollateral` - Existing ERC20 tokens (USDC, DAI, WBTC, etc.) with movable collateral for rebalancing
- `HypPrivateSynthetic` - Minted/burned synthetic tokens

**Key Features**:

- Remote router enrollment (like standard warp routes)
- Commitment generation and tracking
- Nonce-based uniqueness
- Replay attack prevention

#### **B. Aleo Privacy Hub**

Leo contract (`privacy_hub.aleo`) that serves as the privacy middleware.

**Capabilities**:

- Receives deposits from any origin chain
- Stores transfer details in **private records** (amounts encrypted on-chain)
- Verifies commitments before forwarding
- Forwards to destination chains (sender-controlled timing)
- Handles expiry and refunds
- User registration system (links EVM addresses to Aleo addresses)
- Router migration support (handles router upgrades)

**Privacy Guarantee**: All deposit details (amount, recipient, destination router) stored in encrypted private records - invisible to blockchain observers.

#### **C. TypeScript SDK**

Two separate adapters for clean code organization:

**`PrivateWarpOriginAdapter`** - Origin chain operations:

- Deposit tokens with commitment generation
- Receive tokens from Aleo
- Remote router enrollment
- Collateral rebalancing (for collateral type)
- Balance queries

**`AleoPrivacyHubAdapter`** - Aleo-specific operations:

- User registration (one-time setup)
- Forward deposits to destinations
- Timing control
- Refund expired deposits
- Aleo wallet integration (Leo Wallet, Puzzle, SDK)

#### **D. CLI Integration**

Commands for deploying and using privacy warp routes:

- `hyperlane privacy setup` - One-time setup wizard (Aleo wallet + registration)
- `hyperlane privacy register` - Register Aleo address for private transfers
- `hyperlane warp deploy --config private-warp-config.json` - Deploy privacy route
- `hyperlane warp send-private` - Deposit on origin chain
- `hyperlane warp forward` - Forward from Aleo to destination
- `hyperlane warp refund` - Refund expired deposit
- `hyperlane warp rebalance` - Rebalance collateral (collateral type)

---

### 1.3 Data Flow Example: USDC from Ethereum to Polygon

```
User: Alice on Ethereum
Recipient: Bob on Polygon
Amount: 1000 USDC

┌─────────────────────────────────────────────────────────────────┐
│ STEP 0: One-Time Setup (if not already registered)              │
└─────────────────────────────────────────────────────────────────┘

Alice:
  1. Installs Aleo wallet (Leo Wallet)
  2. Funds Aleo wallet with ~0.1 credits (~$0.01)
  3. Registers: privacy_hub.register_user(ethereum_chain_id, alice_address)

On-chain (Aleo):
  ✅ Maps Alice's Ethereum address → Alice's Aleo address
  ✅ Alice can now receive private deposits

This is done ONCE per origin chain.

┌─────────────────────────────────────────────────────────────────┐
│ STEP 1: Alice Deposits on Ethereum                              │
└─────────────────────────────────────────────────────────────────┘

Alice calls: ethereum_contract.depositPrivate(
  secret: 0xrandom32bytes,
  finalDestination: 109,  // Polygon domain
  recipient: 0xBob
)

Action:
  - 1000 USDC locked in Ethereum contract
  - Commitment generated: hash(secret, Bob, 1000, 109, polygon_router, nonce)
  - Message dispatched to Aleo

On-chain (Ethereum):
  ✅ Alice's address VISIBLE
  ✅ Amount VISIBLE (1000 USDC)
  ✅ Commitment hash VISIBLE (but doesn't reveal Bob)
  ✅ Destination domain VISIBLE (Polygon)

┌─────────────────────────────────────────────────────────────────┐
│ STEP 2: Relayer Processes to Aleo (Automatic)                   │
└─────────────────────────────────────────────────────────────────┘

Hyperlane relayer:
  - Detects deposit on Ethereum
  - Fetches validator signatures
  - Submits to Aleo privacy hub

On-chain (Aleo):
  ❌ Amount HIDDEN (in private record)
  ❌ Recipient HIDDEN (in private record)
  ❌ Destination router HIDDEN (in private record)
  ❌ Alice's identity HIDDEN (Aleo address derived from Ethereum, in private record)
  ✅ Only commitment hash stored publicly (used_commitments mapping)

┌─────────────────────────────────────────────────────────────────┐
│ STEP 3: Alice Forwards from Aleo (User-Controlled Timing)       │
└─────────────────────────────────────────────────────────────────┘

Alice calls (on Aleo): privacy_hub.forward_to_destination(
  deposit: [PRIVATE_RECORD],  // Off-chain, from indexer
  secret: 0xrandom32bytes      // Proves knowledge of commitment
)

Action:
  - Aleo verifies commitment: hash(secret, Bob, 1000, ...) == stored commitment
  - Verifies destination router matches commitment
  - Dispatches to Polygon router
  - Marks commitment as used

On-chain (Aleo):
  ✅ Secret VISIBLE (but doesn't reveal Alice)
  ❌ Amount still HIDDEN (in consumed private record)
  ❌ Recipient still HIDDEN
  ✅ Commitment marked as used

┌─────────────────────────────────────────────────────────────────┐
│ STEP 4: Relayer Delivers to Polygon (Automatic)                 │
└─────────────────────────────────────────────────────────────────┘

Hyperlane relayer:
  - Detects forward on Aleo
  - Fetches validator signatures
  - Submits to Polygon

On-chain (Polygon):
  ✅ Bob's address VISIBLE (receives tokens)
  ✅ Amount VISIBLE (1000 USDC)
  ✅ Sender: aleo1privacy_hub... (NOT Alice!)
  ❌ NO link to Alice's Ethereum address

┌─────────────────────────────────────────────────────────────────┐
│ PRIVACY ANALYSIS                                                 │
└─────────────────────────────────────────────────────────────────┘

Can an observer link Alice → Bob?

Method 1: Match by amount
  ❌ FAILS - Can't see amount on Aleo

Method 2: Match by timing
  ⚠️  WEAK - Alice controls forwarding time (can wait hours/days)

Method 3: Match by commitment
  ❌ FAILS - Commitment hash doesn't reveal Alice or Bob

Method 4: Statistical inference
  ⚠️  POSSIBLE - If only 1-2 concurrent transfers
  ✅ PREVENTED - With 5+ concurrent transfers, correlation breaks down

Conclusion: No deterministic linkage possible. Privacy increases with volume.
```

---

### 1.4 User Registration Requirement

**Why Registration is Needed:**

Aleo uses a different address format than EVM chains. To assign private record
ownership to users, we need to map their EVM address to their Aleo address.

**Registration Process (One-Time per Origin Chain):**

1. User installs Aleo wallet (Leo Wallet recommended)
2. User funds Aleo wallet with ~0.1 credits (~$0.01)
3. User calls `privacy_hub.register_user(origin_chain_id, evm_address)`
4. Aleo stores mapping: `hash(origin_chain_id, evm_address) → aleo_address`

**After Registration:**

- All deposits from that EVM address create records owned by the registered Aleo address
- User can forward using their Aleo wallet
- Full self-custody (no custodians)

**Key Points:**

- ✅ One-time setup per origin chain
- ✅ Cost: ~$0.005 (negligible)
- ✅ Takes ~5 seconds
- ✅ Required before first deposit
- ⚠️ User must maintain Aleo wallet access for deposits to be forwardable

---

## 2. Security Model

### 2.1 Threat Model

#### **What We're Protecting Against**

| Threat                                | Mitigation                                                  |
| ------------------------------------- | ----------------------------------------------------------- |
| **On-chain sender-recipient linkage** | Amount hidden on Aleo, commitment breaks correlation        |
| **Timing analysis**                   | Sender controls forward timing, variable delays             |
| **Amount-based correlation**          | Private records hide amounts during Aleo transit            |
| **Commitment front-running**          | Commitment verified with secret, nonce prevents reuse       |
| **Redirect attacks**                  | Destination router included in commitment, verified on Aleo |
| **Replay attacks**                    | Commitments tracked and marked as used                      |
| **Unauthorized forwarding**           | Only commitment creator knows secret                        |
| **Relayer surveillance**              | Relayers can't see amounts on Aleo blockchain               |

#### **What We're NOT Protecting Against**

| Limitation                        | Reason                                                       | Workaround                                   |
| --------------------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| **Origin amount visibility**      | EVM requires visible transfers from accounts                 | Use multiple deposits with different amounts |
| **Destination amount visibility** | Tokens must be visibly transferred to recipient              | Split transfers to obfuscate total           |
| **Metadata analysis**             | Gas patterns, timestamps visible                             | Randomize timing, use standard gas limits    |
| **Network-level correlation**     | IP addresses visible to network observers                    | Use Tor/VPN (out of scope)                   |
| **Very low volume**               | With <3 concurrent transfers, statistical inference possible | Document limitation, incentivize volume      |

### 2.2 Security Assumptions

**Core Assumptions** (What we trust):

1. ✅ **Aleo's zkSNARK Security**: Zero-knowledge proofs are sound and don't leak information
2. ✅ **Private Record Encryption**: Aleo's record encryption (based on account view keys) is secure
3. ✅ **Hyperlane ISM Security**: Interchain Security Modules correctly verify messages
4. ✅ **Commitment Preimage Resistance**: keccak256 hash function is preimage-resistant
5. ✅ **Relayer Liveness**: Relayers eventually process messages (may delay, but not censor)

**Non-Assumptions** (What we DON'T trust):

1. ❌ Origin chains provide privacy
2. ❌ Destination chains provide privacy
3. ❌ Network-level privacy (Tor/VPN separate)
4. ❌ Relayers keep secrets (assume public surveillance)
5. ❌ Users perfectly secure their commitment files (provide expiry/refund mechanism)

### 2.3 Commitment Security

#### **Commitment Structure**

```solidity
commitment = keccak256(abi.encode(
    secret,              // 32 bytes - user-generated randomness
    recipient,           // 32 bytes - final recipient address
    amount,              // 32 bytes (uint256) - transfer amount
    destinationDomain,   // 4 bytes (uint32) - destination chain ID
    destinationRouter,   // 32 bytes - destination contract address
    nonce                // 32 bytes (uint256) - contract nonce (auto-incremented)
))
```

**Security Properties**:

| Property                 | Provided By                | Benefit                                        |
| ------------------------ | -------------------------- | ---------------------------------------------- |
| **Uniqueness**           | Nonce (auto-incremented)   | Same secret can't create duplicate commitments |
| **Collision Resistance** | keccak256 (256-bit output) | Probability of collision: ~2^-256              |
| **Preimage Resistance**  | keccak256                  | Cannot reverse commitment to find secret       |
| **Recipient Binding**    | Recipient in hash          | Cannot redirect to different recipient         |
| **Amount Binding**       | Amount in hash             | Cannot change transfer amount                  |
| **Router Binding**       | destinationRouter in hash  | Cannot redirect to malicious contract          |
| **Domain Binding**       | destinationDomain in hash  | Cannot redirect to different chain             |

#### **Why No Salt?**

**Original Design**: `hash(secret, recipient, amount, salt)`
**Updated Design**: `hash(secret, recipient, amount, ..., nonce)`

**Rationale**:

- Salt was used for additional randomness
- Contract nonce provides the same uniqueness guarantee
- Simpler for users (one less value to manage)
- Nonce auto-increments, preventing accidental reuse

### 2.4 Key Security Considerations

#### **A. Commitment Replay Prevention**

**Risk**: Attacker reuses commitment on different chain.

**Mitigation**:

```solidity
// Track used commitments on destination chains
mapping(bytes32 => bool) public usedCommitments;

function _handle(..., bytes calldata _message) internal {
    bytes32 commitment = decode(message).commitment;
    require(!usedCommitments[commitment], "Already used");
    usedCommitments[commitment] = true;
    // ...
}
```

```leo
// Track used commitments on Aleo
mapping used_commitments: field => bool;

async function finalize_forward(...) {
    assert(!used_commitments.contains(commitment));
    used_commitments.set(commitment, true);
}
```

#### **B. Destination Router Enforcement**

**Risk**: Attacker redirects transfer to malicious router contract.

**Mitigation**:

```leo
// Commitment includes destination router
let computed = compute_commitment(
    secret, recipient, amount, domain, router, nonce
);
assert_eq(computed, deposit.commitment);

// Router must match what's in commitment
assert_eq(unverified_remote_router.recipient, deposit.destination_router);
```

#### **C. Insufficient Collateral (Movable Collateral)**

**Risk**: Destination chain runs out of collateral, transfer gets stuck.

**Mitigation**:

```solidity
// HypPrivateCollateral supports rebalancing
function transferRemoteCollateral(
    uint32 destination,
    uint256 amount
) external onlyOwner returns (bytes32 messageId) {
    // Move collateral from this chain to destination
    // Bypasses Aleo for immediate liquidity management
}
```

**Monitoring**:

- Track collateral balances across all chains
- Alert when balance drops below threshold
- Automated rebalancing scripts

#### **D. Expiry and Refunds**

**Risk**: User loses private record, funds locked forever.

**Mitigation**:

```leo
record PrivateDeposit {
    expiry: u32,  // Block height when expires (e.g., 30 days)
    // ...
}

transition refund_expired(private deposit: PrivateDeposit, ...) {
    assert(block.height > deposit.expiry);
    // Dispatch refund to origin chain (to any address user specifies)
}
```

**Expiry Period**: 30 days (518,400 blocks at 5 seconds/block)

#### **E. Front-Running Protection**

**Risk**: Attacker observes forward transaction in mempool, extracts secret, front-runs.

**Mitigation**:

```leo
// Only record owner can forward (CRITICAL SECURITY CHECK)
assert_eq(deposit.owner, self.signer);

// Even if secret is public, only owner can spend the private record
// Aleo VM enforces record ownership cryptographically
```

**Additional Protection**: Use private fee on Aleo (`privateFee: true`) to hide transaction from mempool.

---

#### **F. Unauthorized Refund Prevention**

**Risk**: After expiry, attacker claims refund to their own address.

**Mitigation**:

```leo
async transition refund_expired(
    private deposit: PrivateDeposit,
    public refund_recipient: [u8; 32]
) -> Future {
    assert(block.height > deposit.expiry);

    // CRITICAL: Only record owner can refund
    assert_eq(deposit.owner, self.signer);

    // User can specify any refund address (flexibility)
}
```

**Security Property**: Aleo VM enforces record ownership. Even if attacker
discovers an expired record via indexing, they cannot spend it without the
owner's Aleo private key.

---

#### **G. Router Upgrade Handling**

**Risk**: Destination router is upgraded, pending deposits become unforwardable.

**Mitigation**:

```leo
// Router migration mapping
mapping router_migrations: [u8; 32] => [u8; 32];

async function finalize_forward_to_destination(...) {
    // Check if router has been migrated
    let target_router = if router_migrations.contains(deposit_router) {
        router_migrations.get(deposit_router)  // Use new router
    } else {
        deposit_router  // Use original
    };

    // Verify target router is enrolled
    assert_eq(enrolled_router.recipient, target_router);
}
```

**Deployment Best Practice**: Deploy all routers as upgradeable proxies
(TransparentUpgradeableProxy) so address never changes.

---

### 2.5 Privacy Limitations and Volume Dependency

#### **Critical Limitation: Volume-Dependent Privacy**

**Privacy Strength Calculation:**

```
Anonymity Set Size = Concurrent pending deposits to same destination
Privacy decreases dramatically with low volume:

1-2 concurrent transfers:  WEAK    (>80% linkability via timing/amount)
3-5 concurrent transfers:  MODERATE (~40-60% linkability)
5-10 concurrent transfers: GOOD    (~20-30% linkability)
10+ concurrent transfers:  STRONG  (<20% linkability)
```

**Launch Phase Reality:**
During initial weeks/months, transfer volume will be low. Users should NOT
rely on strong privacy guarantees until volume reaches sustainable levels
(>20 transfers/day per route).

**User Guidance:**

- ✅ System displays current anonymity set size before deposit
- ✅ CLI warns when privacy is weak (<5 concurrent transfers)
- ✅ Documentation clearly explains volume dependency
- ⚠️ Early adopters should expect LIMITED privacy

**Future Improvements (Post-MVP):**

- Timing randomization (automatic delays based on volume)
- Volume indicators in UI
- Batching mechanisms
- Decoy deposits (protocol-funded)

**For MVP:** Document limitations clearly. Ship basic implementation to validate
technical feasibility. Privacy enhancements come in Phase 2 after core works.

---

## 3. Technical Specifications

### 3.1 Smart Contract Interfaces

#### **A. Base Contract: `HypPrivate.sol`**

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {TokenRouter} from "../libs/TokenRouter.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

/**
 * @title HypPrivate
 * @notice Base contract for privacy-enhanced cross-chain token transfers
 * @dev Single contract per chain - can both send and receive
 */
abstract contract HypPrivate is TokenRouter {

    using TypeCasts for bytes32;
    using TypeCasts for address;

    // ============ Immutables ============

    bytes32 public immutable aleoPrivacyHub;
    uint32 public immutable aleoDomain;

    // ============ Public Storage ============

    uint256 public commitmentNonce;
    mapping(bytes32 => bool) public usedCommitments;
    mapping(uint32 => bytes32) public remoteRouters;

    // ============ Events ============

    event DepositToPrivacyHub(
        address indexed depositor,
        bytes32 indexed commitment,
        uint32 finalDestination,
        bytes32 destinationRouter,
        uint256 amount
    );

    event ReceivedFromPrivacyHub(
        bytes32 indexed commitment,
        address indexed recipient,
        uint256 amount
    );

    event RemoteRouterEnrolled(
        uint32 indexed domain,
        bytes32 router
    );

    // ============ Constructor ============

    constructor(
        address _mailbox,
        bytes32 _aleoPrivacyHub,
        uint32 _aleoDomain
    ) TokenRouter(_mailbox) {
        aleoPrivacyHub = _aleoPrivacyHub;
        aleoDomain = _aleoDomain;
        commitmentNonce = 0;
    }

    // ============ External Functions ============

    /**
     * @notice Enroll a remote router for a destination domain
     * @dev Must be called before deposits can be made to that destination
     * @param domain Destination domain ID
     * @param router Address of HypPrivate contract on destination
     */
    function enrollRemoteRouter(
        uint32 domain,
        bytes32 router
    ) external onlyOwner {
        require(domain != aleoDomain, "Cannot enroll Aleo");
        remoteRouters[domain] = router;
        emit RemoteRouterEnrolled(domain, router);
    }

    /**
     * @notice Compute commitment hash
     * @param secret User-generated 32-byte secret
     * @param recipient Final recipient address (bytes32)
     * @param amount Transfer amount
     * @param destinationDomain Destination chain domain ID
     * @param destinationRouter Destination HypPrivate contract address
     * @param nonce Current commitment nonce
     * @return Commitment hash
     */
    function computeCommitment(
        bytes32 secret,
        bytes32 recipient,
        uint256 amount,
        uint32 destinationDomain,
        bytes32 destinationRouter,
        uint256 nonce
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(
            secret,
            recipient,
            amount,
            destinationDomain,
            destinationRouter,
            nonce
        ));
    }

    /**
     * @notice Deposit tokens for private transfer via Aleo
     * @param secret User-generated 32-byte secret
     * @param finalDestination Destination chain domain ID
     * @param recipient Final recipient address (bytes32)
     * @return messageId Hyperlane message ID
     * @return commitment Generated commitment hash
     */
    function depositPrivate(
        bytes32 secret,
        uint32 finalDestination,
        bytes32 recipient
    ) external payable returns (bytes32 messageId, bytes32 commitment) {
        require(finalDestination != aleoDomain, "Cannot deposit to Aleo");

        // Get enrolled destination router
        bytes32 destinationRouter = remoteRouters[finalDestination];
        require(destinationRouter != bytes32(0), "Router not enrolled");

        // Transfer tokens from sender
        uint256 amount = _transferFromSender(_msgValue());

        // Generate commitment with current nonce
        uint256 nonce = commitmentNonce++;

        commitment = computeCommitment(
            secret,
            recipient,
            amount,
            finalDestination,
            destinationRouter,
            nonce
        );

        // Encode message: [commitment][amount][nonce][finalDest][recipient][destRouter]
        // Using encodePacked for fixed layout (Aleo compatibility)
        bytes memory messageBody = abi.encodePacked(
            commitment,        // 32 bytes
            amount,            // 32 bytes (uint256)
            uint32(nonce),     // 4 bytes
            finalDestination,  // 4 bytes
            recipient,         // 32 bytes
            destinationRouter  // 32 bytes
        );
        // Total: 136 bytes

        // Pad to 141 bytes (supported Aleo message length)
        messageBody = abi.encodePacked(messageBody, new bytes(5));

        // Dispatch to Aleo privacy hub
        messageId = _dispatch(
            aleoDomain,
            aleoPrivacyHub,
            messageBody
        );

        emit DepositToPrivacyHub(
            msg.sender,
            commitment,
            finalDestination,
            destinationRouter,
            amount
        );
    }

    /**
     * @notice Handle incoming transfer from Aleo privacy hub
     * @dev Called by Mailbox.process()
     * @param _origin Origin domain (must be Aleo)
     * @param _sender Sender address (must be Aleo privacy hub)
     * @param _message Message: [recipient][amount][commitment]
     */
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal override {
        require(_origin == aleoDomain, "Only from Aleo");
        require(_sender == aleoPrivacyHub, "Only from hub");

        // Decode message
        (bytes32 recipientBytes, uint256 amount, bytes32 commitment) =
            abi.decode(_message, (bytes32, uint256, bytes32));

        address recipient = recipientBytes.bytes32ToAddress();

        // Prevent commitment replay
        require(!usedCommitments[commitment], "Commitment used");
        usedCommitments[commitment] = true;

        // Transfer to recipient
        _transferTo(recipient, amount);

        emit ReceivedFromPrivacyHub(commitment, recipient, amount);
    }

    // ============ Query Functions ============

    function isCommitmentUsed(bytes32 commitment)
        external view returns (bool)
    {
        return usedCommitments[commitment];
    }

    // ============ Abstract Methods ============

    function _transferFromSender(uint256 _amount)
        internal virtual returns (uint256);

    function _transferTo(address _recipient, uint256 _amount)
        internal virtual;
}
```

#### **B. Native Token: `HypPrivateNative.sol`**

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {HypPrivate} from "./HypPrivate.sol";

/**
 * @title HypPrivateNative
 * @notice Privacy-enhanced native token transfers (ETH, MATIC, AVAX, etc.)
 */
contract HypPrivateNative is HypPrivate {

    constructor(
        address _mailbox,
        bytes32 _aleoPrivacyHub,
        uint32 _aleoDomain
    ) HypPrivate(_mailbox, _aleoPrivacyHub, _aleoDomain) {}

    /**
     * @notice Accept native token from sender
     */
    function _transferFromSender(uint256 _amount)
        internal override returns (uint256)
    {
        require(msg.value == _amount, "Value mismatch");
        return _amount;
    }

    /**
     * @notice Send native token to recipient
     */
    function _transferTo(address _recipient, uint256 _amount)
        internal override
    {
        (bool success, ) = _recipient.call{value: _amount}("");
        require(success, "Native transfer failed");
    }

    /**
     * @notice Receive native tokens
     */
    receive() external payable {}
}
```

#### **C. ERC20 Collateral: `HypPrivateCollateral.sol`**

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {HypPrivate} from "./HypPrivate.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title HypPrivateCollateral
 * @notice Privacy-enhanced ERC20 transfers with movable collateral
 * @dev Supports rebalancing to prevent stuck transfers
 */
contract HypPrivateCollateral is HypPrivate {

    using SafeERC20 for IERC20;

    // ============ Immutables ============

    IERC20 public immutable wrappedToken;

    // ============ Events ============

    event CollateralSent(uint32 indexed destination, uint256 amount);
    event CollateralReceived(uint32 indexed origin, uint256 amount);

    // ============ Constructor ============

    constructor(
        address _mailbox,
        address _wrappedToken,
        bytes32 _aleoPrivacyHub,
        uint32 _aleoDomain
    ) HypPrivate(_mailbox, _aleoPrivacyHub, _aleoDomain) {
        wrappedToken = IERC20(_wrappedToken);
    }

    // ============ Token Transfer Methods ============

    function _transferFromSender(uint256 _amount)
        internal override returns (uint256)
    {
        require(msg.value == 0, "No native token");
        wrappedToken.safeTransferFrom(msg.sender, address(this), _amount);
        return _amount;
    }

    function _transferTo(address _recipient, uint256 _amount)
        internal override
    {
        wrappedToken.safeTransfer(_recipient, _amount);
    }

    // ============ Rebalancing Functions ============

    /**
     * @notice Move collateral to another chain for rebalancing
     * @dev Sends directly to destination (bypasses Aleo for speed)
     * @param destination Destination domain ID
     * @param amount Amount of collateral to move
     * @return messageId Hyperlane message ID
     */
    function transferRemoteCollateral(
        uint32 destination,
        uint256 amount
    ) external onlyOwner returns (bytes32 messageId) {
        require(destination != aleoDomain, "Cannot rebalance to Aleo");

        bytes32 destinationRouter = remoteRouters[destination];
        require(destinationRouter != bytes32(0), "Router not enrolled");

        // Check sufficient balance
        uint256 balance = wrappedToken.balanceOf(address(this));
        require(balance >= amount, "Insufficient collateral");

        // Encode rebalance message (type = 0x01)
        bytes memory messageBody = abi.encodePacked(
            bytes1(0x01),  // Rebalance message type
            amount
        );

        // Dispatch directly to destination (bypass Aleo)
        messageId = _dispatch(destination, destinationRouter, messageBody);

        emit CollateralSent(destination, amount);
    }

    /**
     * @notice Handle messages - supports both private transfers and rebalancing
     */
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal override {
        // Check message type
        if (_message.length > 0 && _message[0] == 0x01) {
            // Rebalance message - from enrolled router
            require(remoteRouters[_origin] == _sender, "Router not enrolled");

            uint256 amount = abi.decode(_message[1:], (uint256));

            emit CollateralReceived(_origin, amount);
        } else {
            // Private transfer - from Aleo only
            super._handle(_origin, _sender, _message);
        }
    }

    // ============ Query Functions ============

    /**
     * @notice Get total collateral balance
     */
    function collateralBalance() external view returns (uint256) {
        return wrappedToken.balanceOf(address(this));
    }
}
```

#### **D. Synthetic Token: `HypPrivateSynthetic.sol`**

```solidity
// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {HypPrivate} from "./HypPrivate.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";

/**
 * @title HypPrivateSynthetic
 * @notice Privacy-enhanced synthetic token transfers
 * @dev Mints on receive, burns on deposit
 */
contract HypPrivateSynthetic is HypPrivate, ERC20Upgradeable {

    uint8 private immutable _decimals;

    constructor(
        uint8 __decimals,
        address _mailbox,
        bytes32 _aleoPrivacyHub,
        uint32 _aleoDomain
    ) HypPrivate(_mailbox, _aleoPrivacyHub, _aleoDomain) {
        _decimals = __decimals;
    }

    function initialize(
        string memory _name,
        string memory _symbol,
        address _hook,
        address _interchainSecurityModule,
        address _owner
    ) external initializer {
        __ERC20_init(_name, _symbol);
        _MailboxClient_initialize(_hook, _interchainSecurityModule, _owner);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function _transferFromSender(uint256 _amount)
        internal override returns (uint256)
    {
        require(msg.value == 0, "No native token");
        _burn(msg.sender, _amount);
        return _amount;
    }

    function _transferTo(address _recipient, uint256 _amount)
        internal override
    {
        _mint(_recipient, _amount);
    }
}
```

#### **E. Aleo Privacy Hub: `privacy_hub.aleo`**

```leo
import mailbox.aleo;
import dispatch_proxy.aleo;
import token_registry.aleo;

program privacy_hub.aleo {

    // ============ Records ============

    // PRIVATE record - all fields encrypted on-chain
    record PrivateDeposit {
        owner: address,              // Owner who can forward (HIDDEN)
        commitment: field,           // Unique identifier (HIDDEN)
        nonce: u32,                  // Commitment nonce (HIDDEN)
        amount: [u128; 2],           // Transfer amount as u256 (HIDDEN)
        final_destination: u32,      // Destination domain (HIDDEN)
        recipient: [u8; 32],         // Final recipient (HIDDEN)
        destination_router: [u8; 32],// Destination contract (HIDDEN)
        origin_chain: u32,           // Origin domain (HIDDEN)
        token_id: field,             // Token type (HIDDEN)
        timestamp: u32,              // Deposit time (HIDDEN)
        expiry: u32,                 // Expiration height (HIDDEN)
    }

    // ============ Mappings ============

    mapping used_commitments: field => bool;
    mapping hub_config: bool => HubConfig;
    mapping remote_routers: u32 => RemoteRouter;
    mapping user_registrations: field => address;  // EVM address hash -> Aleo address
    mapping router_migrations: [u8; 32] => [u8; 32];  // old_router -> new_router

    // ============ Structs ============

    struct HubConfig {
        admin: address,
        min_claim_delay: u32,    // Min blocks between deposit and forward
        expiry_blocks: u32,      // Blocks until deposit expires
        paused: bool,
    }

    struct RemoteRouter {
        domain: u32,
        recipient: [u8; 32],
        gas: u128,
    }

    struct Message {
        version: u8,
        nonce: u32,
        origin_domain: u32,
        sender: [u8; 32],
        destination_domain: u32,
        recipient: [u8; 32],
        body: [u128; 16],
    }

    struct MailboxState {
        local_domain: u32,
        nonce: u32,
        process_count: u32,
        default_ism: address,
        default_hook: address,
        required_hook: address,
        dispatch_proxy: address,
        mailbox_owner: address,
    }

    struct HookMetadata {
        gas_limit: u128,
        extra_data: [u8; 64],
    }

    struct CreditAllowance {
        spender: address,
        amount: u64,
    }

    // ============ Constants ============

    const NULL_ADDRESS: address = aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc;
    const EXPIRY_BLOCKS: u32 = 518400u32;  // ~30 days
    const EXPIRY_GRACE_BLOCKS: u32 = 10u32;  // ~50 seconds grace period

    // ============ Initialization ============

    async transition init(admin: address) -> Future {
        return finalize_init(admin, self.caller);
    }

    async function finalize_init(admin: address, caller: address) {
        assert(!hub_config.contains(true));

        hub_config.set(true, HubConfig {
            admin: admin,
            min_claim_delay: 5u32,       // 5 blocks (~25 seconds)
            expiry_blocks: EXPIRY_BLOCKS,
            paused: false,
        });

        let program_id = get_program_id();
        mailbox.aleo/register_application(program_id).await();
    }

    // ============ User Registration ============

    async transition register_user(
        public origin_chain: u32,
        public origin_address: [u8; 32]
    ) -> Future {
        let aleo_address = self.signer;
        return finalize_register_user(origin_chain, origin_address, aleo_address);
    }

    async function finalize_register_user(
        origin_chain: u32,
        origin_address: [u8; 32],
        aleo_address: address
    ) {
        let key = compute_registration_key(origin_chain, origin_address);
        user_registrations.set(key, aleo_address);
    }

    // ============ Configuration ============

    async transition enroll_remote_router(
        destination: u32,
        recipient: [u8; 32],
        gas: u128
    ) -> Future {
        let caller = self.caller;
        return async {
            let config = hub_config.get(true);
            assert_eq(config.admin, caller);

            remote_routers.set(destination, RemoteRouter {
                domain: destination,
                recipient: recipient,
                gas: gas,
            });
        };
    }

    async transition set_paused(paused: bool) -> Future {
        let caller = self.caller;
        return async {
            let config = hub_config.get(true);
            assert_eq(config.admin, caller);
            config.paused = paused;
            hub_config.set(true, config);
        };
    }

    async transition migrate_router(
        public old_router: [u8; 32],
        public new_router: [u8; 32]
    ) -> Future {
        let caller = self.caller;
        return async {
            let config = hub_config.get(true);
            assert_eq(config.admin, caller);
            router_migrations.set(old_router, new_router);
        };
    }

    // ============ Core Functions ============

    /**
     * Process incoming deposit from origin chain
     * Creates private record with all details hidden
     */
    async transition receive_deposit(
        public unverified_ism: address,
        public message: Message,
        public message_length: u32,
        public id: [u128; 2],
        public metadata: [u8; 512]
    ) -> (PrivateDeposit, Future) {

        // Verify message through mailbox
        let mailbox_future = mailbox.aleo/process(
            unverified_ism,
            message,
            message_length,
            id,
            metadata
        );

        // Decode message body
        // [commitment][amount][nonce][finalDest][recipient][destRouter]
        let deposit_msg = decode_deposit_message(message.body);

        // Lookup registered Aleo address for owner
        let key = compute_registration_key(message.origin_domain, message.sender);
        assert(user_registrations.contains(key));
        let owner_address = user_registrations.get(key);

        // Create PRIVATE record - ALL details encrypted on-chain
        let private_deposit = PrivateDeposit {
            owner: owner_address,
            commitment: deposit_msg.commitment,
            nonce: deposit_msg.nonce,
            amount: deposit_msg.amount,
            final_destination: deposit_msg.final_destination,
            recipient: deposit_msg.recipient,
            destination_router: deposit_msg.destination_router,
            origin_chain: message.origin_domain,
            token_id: get_default_token_id(),
            timestamp: block.height,
            expiry: block.height + EXPIRY_BLOCKS,
        };

        return (
            private_deposit,
            finalize_receive_deposit(deposit_msg.commitment, mailbox_future)
        );
    }

    async function finalize_receive_deposit(
        commitment: field,
        mailbox_future: Future
    ) {
        // Check not paused
        let config = hub_config.get(true);
        assert(!config.paused);

        // Verify mailbox processing
        mailbox_future.await();

        // Commitment must be unique
        assert(!used_commitments.contains(commitment));
    }

    /**
     * Forward deposit to final destination
     * Sender controls when this happens for privacy
     */
    async transition forward_to_destination(
        private deposit: PrivateDeposit,
        public secret: [u8; 32],
        public unverified_config: HubConfig,
        public unverified_mailbox_state: MailboxState,
        public unverified_remote_router: RemoteRouter,
        public allowance: [CreditAllowance; 4]
    ) -> Future {

        // Verify ownership (only record owner can forward)
        assert_eq(deposit.owner, self.signer);

        // Verify not expired (with grace period to prevent race conditions)
        assert(block.height < deposit.expiry + EXPIRY_GRACE_BLOCKS);

        // CRITICAL: Verify commitment matches
        let computed_commitment = compute_commitment(
            secret,
            deposit.recipient,
            deposit.amount,
            deposit.final_destination,
            deposit.destination_router,
            deposit.nonce  // Use nonce from record
        );
        assert_eq(computed_commitment, deposit.commitment);

        // CRITICAL: Verify destination router matches commitment
        assert_eq(
            unverified_remote_router.recipient,
            deposit.destination_router
        );

        // Prepare message for destination
        // [recipient][amount][commitment]
        let message_body = encode_forward_message(
            deposit.recipient,
            deposit.amount,
            deposit.commitment
        );

        // Get hook metadata
        let hook_metadata = HookMetadata {
            gas_limit: unverified_remote_router.gas,
            extra_data: [0u8; 64],
        };

        // Dispatch to destination
        let dispatch_future = dispatch_proxy.aleo/dispatch(
            unverified_mailbox_state,
            deposit.final_destination,
            deposit.destination_router,  // Use router from commitment
            message_body,
            NULL_ADDRESS,
            hook_metadata,
            allowance
        );

        return finalize_forward_to_destination(
            deposit.commitment,
            deposit.timestamp,
            deposit.final_destination,
            deposit.destination_router,
            deposit.token_id,
            deposit.amount,
            unverified_config,
            unverified_remote_router,
            dispatch_future
        );
    }

    async function finalize_forward_to_destination(
        commitment: field,
        deposit_timestamp: u32,
        final_destination: u32,
        deposit_router: [u8; 32],
        token_id: field,
        amount: [u128; 2],
        unverified_config: HubConfig,
        unverified_remote_router: RemoteRouter,
        dispatch_future: Future
    ) {
        // Verify config matches
        let actual_config = hub_config.get(true);
        assert_eq(actual_config, unverified_config);
        assert(!actual_config.paused);

        // Verify minimum delay passed
        assert(block.height >= deposit_timestamp + actual_config.min_claim_delay);

        // Mark commitment as used (prevent replay)
        assert(!used_commitments.contains(commitment));
        used_commitments.set(commitment, true);

        // Check if router has been migrated
        let target_router = if router_migrations.contains(deposit_router) {
            router_migrations.get(deposit_router)
        } else {
            deposit_router
        };

        // Verify target router matches provided router
        assert_eq(target_router, unverified_remote_router.recipient);

        // Verify router is enrolled for destination
        let enrolled_router = remote_routers.get(final_destination);
        assert_eq(enrolled_router.recipient, target_router);

        // Transfer tokens out
        token_registry.aleo/transfer_public(
            token_id,
            dispatch_proxy.aleo.address,
            amount
        );

        // Complete dispatch
        dispatch_future.await();
    }

    // ============ SPLIT TRANSFERS - PHASE 2 FEATURE ============
    // Note: Split transfers removed from MVP due to Leo language constraints
    // (variable loop bounds not supported). Will be added in Phase 2 with
    // fixed maximum split count (e.g., always 4 splits with conditional execution).
    //
    // For MVP, users can achieve split transfers manually by:
    // 1. Forwarding deposit to self on intermediate chain
    // 2. Making separate deposits for each split amount
    // 3. Forwarding each to final destinations

    /**
     * Refund expired deposit to origin chain
     * Only the record owner can initiate refund
     */
    async transition refund_expired(
        private deposit: PrivateDeposit,
        public refund_recipient: [u8; 32],
        public unverified_mailbox_state: MailboxState,
        public allowance: [CreditAllowance; 4]
    ) -> Future {

        // CRITICAL: Verify ownership (prevents unauthorized refunds)
        assert_eq(deposit.owner, self.signer);

        // Verify expired
        assert(block.height > deposit.expiry);

        // Encode refund message
        let message_body = encode_forward_message(
            refund_recipient,
            deposit.amount,
            deposit.commitment
        );

        // Get origin chain router
        let origin_router = remote_routers.get(deposit.origin_chain);

        // Get hook metadata
        let hook_metadata = HookMetadata {
            gas_limit: origin_router.gas,
            extra_data: [0u8; 64],
        };

        // Dispatch refund to origin
        let dispatch_future = dispatch_proxy.aleo/dispatch(
            unverified_mailbox_state,
            deposit.origin_chain,
            origin_router.recipient,
            message_body,
            NULL_ADDRESS,
            hook_metadata,
            allowance
        );

        return finalize_refund(deposit.commitment, dispatch_future);
    }

    async function finalize_refund(
        commitment: field,
        dispatch_future: Future
    ) {
        // Mark commitment as used
        assert(!used_commitments.contains(commitment));
        used_commitments.set(commitment, true);

        dispatch_future.await();
    }

    // ============ Helper Functions ============

    inline compute_commitment(
        secret: [u8; 32],
        recipient: [u8; 32],
        amount: [u128; 2],
        destination_domain: u32,
        destination_router: [u8; 32],
        nonce: u32
    ) -> field {
        let data = concatenate_commitment_data(
            secret,
            recipient,
            amount,
            destination_domain,
            destination_router,
            nonce
        );
        // CRITICAL: Use Keccak256 (matches Solidity keccak256)
        return Keccak256::hash_to_field(data);
    }

    inline concatenate_commitment_data(
        secret: [u8; 32],
        recipient: [u8; 32],
        amount: [u128; 2],
        destination_domain: u32,
        destination_router: [u8; 32],
        nonce: u32
    ) -> [u8; 140] {
        let mut data: [u8; 140] = [0u8; 140];

        // secret: 32 bytes (offset 0)
        for i in 0u8..32u8 {
            data[i] = secret[i];
        }

        // recipient: 32 bytes (offset 32)
        for i in 0u8..32u8 {
            data[32u8 + i] = recipient[i];
        }

        // amount: 32 bytes (offset 64) - convert [u128; 2] to bytes
        let amount_bytes = u128_pair_to_bytes32(amount);
        for i in 0u8..32u8 {
            data[64u8 + i] = amount_bytes[i];
        }

        // destination_domain: 4 bytes (offset 96)
        let domain_bytes = u32_to_bytes_le(destination_domain);
        for i in 0u8..4u8 {
            data[96u8 + i] = domain_bytes[i];
        }

        // destination_router: 32 bytes (offset 100)
        for i in 0u8..32u8 {
            data[100u8 + i] = destination_router[i];
        }

        // nonce: 8 bytes (offset 132) - use u64 to match Solidity uint256
        let nonce_bytes = u64_to_bytes_le(nonce as u64);
        for i in 0u8..8u8 {
            data[132u8 + i] = nonce_bytes[i];
        }

        return data;
    }

    inline compute_registration_key(chain: u32, addr: [u8; 32]) -> field {
        // Pack chain ID + address for registration lookup
        let mut data: [u8; 36] = [0u8; 36];

        let chain_bytes = u32_to_bytes_le(chain);
        for i in 0u8..4u8 {
            data[i] = chain_bytes[i];
        }

        for i in 0u8..32u8 {
            data[4u8 + i] = addr[i];
        }

        return Keccak256::hash_to_field(data);
    }

    inline decode_deposit_message(body: [u128; 16]) -> DepositMessage {
        // Message layout: [commitment(32)][amount(32)][nonce(4)][dest(4)][recipient(32)][router(32)]
        let commitment = u128_pair_to_field([body[0], body[1]]);
        let amount: [u128; 2] = [body[2], body[3]];
        let nonce = extract_u32_from_u128(body[4], 0u8);
        let final_dest = extract_u32_from_u128(body[4], 4u8);
        let recipient = u128_pair_to_bytes32([body[5], body[6]]);
        let dest_router = u128_pair_to_bytes32([body[7], body[8]]);

        return DepositMessage {
            commitment: commitment,
            amount: amount,
            nonce: nonce,
            final_destination: final_dest,
            recipient: recipient,
            destination_router: dest_router,
        };
    }

    struct DepositMessage {
        commitment: field,
        amount: [u128; 2],
        nonce: u32,
        final_destination: u32,
        recipient: [u8; 32],
        destination_router: [u8; 32],
    }

    // Additional helper functions (reuse from existing hyp_native.aleo)
    inline get_program_id() -> [u8; 128] { /* Implementation from hyp_native */ }
    inline get_default_token_id() -> field { /* Implementation TBD */ }

    // Encoding helpers (reuse from hyp_native.aleo)
    inline u128_pair_to_bytes32(pair: [u128; 2]) -> [u8; 32] { /* ... */ }
    inline bytes32_to_u128_pair(bytes: [u8; 32]) -> [u128; 2] { /* ... */ }
    inline u128_pair_to_field(pair: [u128; 2]) -> field { /* ... */ }
    inline field_to_u128_pair(value: field) -> [u128; 2] { /* ... */ }
    inline u128_to_bytes_le(value: u128) -> [u8; 16] { /* ... */ }
    inline u32_to_bytes_le(value: u32) -> [u8; 4] { /* ... */ }
    inline u64_to_bytes_le(value: u64) -> [u8; 8] { /* ... */ }
    inline extract_u32_from_u128(value: u128, byte_offset: u8) -> u32 { /* ... */ }

    inline encode_forward_message(
        recipient: [u8; 32],
        amount: [u128; 2],
        commitment: field
    ) -> [u128; 16] {
        // Layout: [recipient(32)][amount(32)][commitment(32)] = 96 bytes, pad to 109
        let mut body: [u128; 16] = [0u128; 16];
        let recipient_u128 = bytes32_to_u128_pair(recipient);
        body[0] = recipient_u128[0];
        body[1] = recipient_u128[1];
        body[2] = amount[0];
        body[3] = amount[1];
        let commitment_u128 = field_to_u128_pair(commitment);
        body[4] = commitment_u128[0];
        body[5] = commitment_u128[1];
        return body;
    }
}
```

---

### 3.2 TypeScript SDK Configuration Types

```typescript
// File: typescript/sdk/src/token/types.ts

export enum TokenType {
  // ... existing types
  synthetic = 'synthetic',
  syntheticRebase = 'syntheticRebase',
  native = 'native',
  nativeScaled = 'nativeScaled',
  collateral = 'collateral',
  collateralVault = 'collateralVault',
  collateralVaultRebase = 'collateralVaultRebase',
  collateralFiat = 'collateralFiat',
  XERC20 = 'XERC20',
  XERC20Lockbox = 'XERC20Lockbox',

  // NEW: Private token types
  privateNative = 'privateNative',
  privateCollateral = 'privateCollateral',
  privateSynthetic = 'privateSynthetic',
}

/**
 * Base interface for all private warp route configurations
 */
export interface PrivateWarpRouterConfig extends TokenRouterConfig {
  // Aleo privacy hub configuration
  aleoPrivacyHub: string; // e.g., "privacy_hub.aleo"
  aleoDomain: number; // e.g., 9999999
  aleoChain?: ChainName; // e.g., "aleo" or "aleotestnet" (default: "aleo")

  // Remote routers (like standard warp routes)
  // Maps destination chain to router address
  remoteRouters?: Record<ChainName, Address>;
}

/**
 * Private native token configuration
 * For blockchain native assets (ETH, MATIC, AVAX, etc.)
 */
export interface PrivateNativeConfig extends PrivateWarpRouterConfig {
  type: TokenType.privateNative;
  // No additional fields - native token is chain's native asset
}

/**
 * Private collateral token configuration
 * For existing ERC20 tokens (USDC, DAI, WBTC, etc.)
 */
export interface PrivateCollateralConfig extends PrivateWarpRouterConfig {
  type: TokenType.privateCollateral;

  // Address of the ERC20 token to wrap
  token: Address; // e.g., "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" (USDC on Ethereum)
}

/**
 * Private synthetic token configuration
 * For minted/burned synthetic tokens
 */
export interface PrivateSyntheticConfig extends PrivateWarpRouterConfig {
  type: TokenType.privateSynthetic;

  // Token metadata
  name: string; // e.g., "Private Wrapped ETH"
  symbol: string; // e.g., "pWETH"
  decimals: number; // e.g., 18
  totalSupply?: bigint; // Optional: initial supply
}

/**
 * Union type of all private warp configurations
 */
export type PrivateWarpConfig =
  | PrivateNativeConfig
  | PrivateCollateralConfig
  | PrivateSyntheticConfig;

// ============ Type Guards ============

export function isPrivateNativeConfig(
  config: TokenRouterConfig,
): config is PrivateNativeConfig {
  return config.type === TokenType.privateNative;
}

export function isPrivateCollateralConfig(
  config: TokenRouterConfig,
): config is PrivateCollateralConfig {
  return config.type === TokenType.privateCollateral;
}

export function isPrivateSyntheticConfig(
  config: TokenRouterConfig,
): config is PrivateSyntheticConfig {
  return config.type === TokenType.privateSynthetic;
}

export function isPrivateWarpConfig(
  config: TokenRouterConfig,
): config is PrivateWarpConfig {
  return (
    isPrivateNativeConfig(config) ||
    isPrivateCollateralConfig(config) ||
    isPrivateSyntheticConfig(config)
  );
}
```

### 3.3 Example Configurations

#### **Example 1: Private Native ETH Route**

```json
{
  "ethereum": {
    "type": "privateNative",
    "aleoPrivacyHub": "privacy_hub.aleo",
    "aleoDomain": 9999999,
    "mailbox": "0x...",
    "owner": "0x...",
    "remoteRouters": {
      "polygon": "0x...",
      "arbitrum": "0x..."
    }
  },
  "polygon": {
    "type": "privateNative",
    "aleoPrivacyHub": "privacy_hub.aleo",
    "aleoDomain": 9999999,
    "mailbox": "0x...",
    "owner": "0x...",
    "remoteRouters": {
      "ethereum": "0x...",
      "arbitrum": "0x..."
    }
  }
}
```

#### **Example 2: Private USDC Collateral Route**

```json
{
  "ethereum": {
    "type": "privateCollateral",
    "token": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "aleoPrivacyHub": "privacy_hub.aleo",
    "aleoDomain": 9999999,
    "mailbox": "0x...",
    "owner": "0x...",
    "remoteRouters": {
      "polygon": "0x...",
      "arbitrum": "0x..."
    }
  },
  "polygon": {
    "type": "privateCollateral",
    "token": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    "aleoPrivacyHub": "privacy_hub.aleo",
    "aleoDomain": 9999999,
    "mailbox": "0x...",
    "owner": "0x...",
    "remoteRouters": {
      "ethereum": "0x...",
      "arbitrum": "0x..."
    }
  }
}
```

#### **Example 3: Private Synthetic Token Route**

```json
{
  "arbitrum": {
    "type": "privateSynthetic",
    "name": "Private Wrapped BTC",
    "symbol": "pWBTC",
    "decimals": 8,
    "aleoPrivacyHub": "privacy_hub.aleo",
    "aleoDomain": 9999999,
    "mailbox": "0x...",
    "owner": "0x...",
    "remoteRouters": {
      "optimism": "0x...",
      "base": "0x..."
    }
  },
  "optimism": {
    "type": "privateSynthetic",
    "name": "Private Wrapped BTC",
    "symbol": "pWBTC",
    "decimals": 8,
    "aleoPrivacyHub": "privacy_hub.aleo",
    "aleoDomain": 9999999,
    "mailbox": "0x...",
    "owner": "0x...",
    "remoteRouters": {
      "arbitrum": "0x...",
      "base": "0x..."
    }
  }
}
```

---

## 4. Implementation Phases

### Phase 1: Core EVM Contracts (4 weeks)

**Week 1: Base Contract + Native Token**

- Implement `HypPrivate.sol` (base contract)
- Implement `HypPrivateNative.sol`
- Unit tests for commitment structure
- Unit tests for router enrollment
- Unit tests for deposit/receive flows

**Week 2: Collateral Token**

- Implement `HypPrivateCollateral.sol`
- Add movable collateral interface
- Rebalancing functions
- Unit tests for ERC20 handling
- Unit tests for rebalancing

**Week 3: Synthetic Token**

- Implement `HypPrivateSynthetic.sol`
- Mint/burn logic
- Unit tests for synthetic token

**Week 4: Integration Testing**

- End-to-end tests: Ethereum → Aleo → Polygon
- Test all token types
- Test rebalancing
- Test commitment verification
- Test privacy guarantees

**Deliverables**:

- ✅ 3 Solidity contracts (Native, Collateral, Synthetic)
- ✅ >95% test coverage
- ✅ All unit tests passing
- ✅ Integration tests passing

---

### Phase 2: Aleo Privacy Hub (2 weeks)

**Week 5: Core Aleo Contract**

- Implement `privacy_hub.aleo`
- Private record structure (with nonce field, [u128; 2] amounts)
- User registration system
- Receive deposit logic with registration lookup
- Forward to destination logic with ownership checks
- Commitment verification (Keccak256)

**Week 6: Advanced Features + Testing**

- Router migration system
- Expiry and refund logic with ownership checks
- Message encoding/decoding helpers (reuse from hyp_native)
- Python integration tests
- Privacy verification tests
- Commitment security tests
- Registration flow tests

**Deliverables**:

- ✅ `privacy_hub.aleo` contract with all security fixes
- ✅ User registration system functional
- ✅ Router migration support
- ✅ >90% test coverage
- ✅ Privacy tests confirming amount hiding
- ✅ Ownership security tests passing
- ✅ All integration tests passing

---

### Phase 3: TypeScript SDK (3 weeks)

**Week 7: Origin Adapter**

- Implement `PrivateWarpOriginAdapter.ts`
- Deposit function with commitment generation (Keccak256)
- Message encoding with nonce (encodePacked, 141-byte padding)
- Remote router enrollment
- Registration check before deposit
- Unit tests

**Week 8: Aleo Hub Adapter**

- Implement `AleoPrivacyHubAdapter.ts`
- User registration function
- Forward function with ownership verification
- Refund expired deposits
- Aleo wallet integration (Leo Wallet, Puzzle)
- Message decoding helpers
- Unit tests

**Week 9: Integration + CLI**

- Integrate adapters with existing WarpCore
- CLI setup wizard (`hyperlane privacy setup`)
- CLI registration command (`hyperlane privacy register`)
- CLI deployment command (with proxy pattern)
- CLI send-private command
- CLI forward command
- CLI refund command
- E2E CLI tests

**Deliverables**:

- ✅ 2 TypeScript adapters
- ✅ CLI commands (setup, register, send, forward, refund)
- ✅ Aleo wallet adapters (Leo, Puzzle, SDK)
- ✅ >95% test coverage
- ✅ E2E tests passing

---

### Phase 4: Testing & Audit (3 weeks)

**Week 10: Comprehensive Testing**

- Integration tests across multiple chains
- Privacy verification tests
- Performance benchmarks
- Gas cost analysis
- User experience testing

**Week 11: Security Audit Preparation**

- Security documentation
- Internal security review
- Bug bounty program setup
- Audit scope definition

**Week 12: External Audit**

- Partner with auditing firm
- Address all findings
- Re-audit if needed

**Deliverables**:

- ✅ All tests passing (>90% coverage)
- ✅ Audit report
- ✅ All critical/high findings resolved
- ✅ Bug bounty program live

---

### Phase 5: Documentation & Launch (1 week)

**Week 13: Documentation + Deployment**

- User documentation
- Developer documentation
- Mainnet deployment
- Relayer configuration
- Public announcement

**Deliverables**:

- ✅ Complete documentation
- ✅ Mainnet contracts deployed
- ✅ Monitoring setup
- ✅ Public launch

---

## 5. Testing Strategy

### 5.1 Unit Tests

#### **Solidity Tests** (Foundry/Forge)

```bash
# Location: solidity/test/token/

HypPrivate.t.sol
├── testEnrollRemoteRouter
├── testCommitmentComputationKeccak256
├── testCommitmentIncludesNonce
├── testNonceIncrement
├── testMessageEncodingPacked
├── testMessagePaddingTo141Bytes
├── testDepositPrivate
├── testReceiveFromAleo109Bytes
├── testRejectsNonAleoOrigin
├── testRejectsWrongSender
├── testCommitmentReplayPrevention
└── testCommitmentIncludesAllParameters

HypPrivateNative.t.sol
├── testNativeDeposit
├── testNativeReceive
└── testReceiveFunctionality

HypPrivateCollateral.t.sol
├── testERC20Deposit
├── testERC20Receive
├── testRebalanceCollateral
├── testCannotWithdrawMoreThanBalance
└── testCollateralMovement

HypPrivateSynthetic.t.sol
├── testMintOnReceive
├── testBurnOnDeposit
└── testERC20Functionality
```

**Coverage Target**: >95%

#### **Leo Tests** (Python Integration)

```bash
# Location: hyperlane-aleo/privacy_hub/tests/

integration.test.py
├── test_user_registration
├── test_registration_required_for_deposit
├── test_receive_deposit
├── test_forward_to_destination
├── test_commitment_verification_keccak256
├── test_router_enforcement
├── test_router_migration
├── test_expiry_refund_with_ownership
├── test_unauthorized_refund_fails
├── test_cannot_forward_expired
└── test_grace_period_forward

privacy.test.py
├── test_amount_privacy (CRITICAL)
├── test_recipient_privacy
├── test_no_public_state_leakage
└── test_commitment_uniqueness

commitment.test.py
├── test_commitment_includes_all_params
├── test_commitment_uses_keccak256
├── test_commitment_with_u256_amounts
├── test_nonce_stored_in_record
├── test_destination_router_enforced
├── test_cannot_use_wrong_secret
└── test_commitment_replay_prevented

router_enforcement.test.py
├── test_cannot_forward_to_wrong_router
├── test_router_must_be_enrolled
├── test_router_mismatch_fails
├── test_router_migration_works
└── test_proxy_router_upgrades

ownership.test.py
├── test_only_owner_can_forward
├── test_only_owner_can_refund
├── test_ownership_enforced_by_aleo_vm
└── test_unauthorized_access_fails
```

**Coverage Target**: >90%

#### **TypeScript Tests** (Mocha/Chai)

```bash
# Location: typescript/sdk/src/token/adapters/

PrivateWarpOriginAdapter.test.ts
├── describe('registration')
│   ├── should check if user registered
│   ├── should fail deposit if not registered
│   └── should provide clear error message
├── describe('deposit')
│   ├── should generate commitment with Keccak256
│   ├── should include nonce in message
│   ├── should pad message to 141 bytes
│   ├── should auto-generate secret
│   ├── should use provided secret
│   ├── should verify router enrollment
│   ├── should save commitment file with nonce
│   └── should handle all token types
├── describe('enrollRemoteRouter')
├── describe('rebalanceCollateral')
└── describe('getBalance')

AleoPrivacyHubAdapter.test.ts
├── describe('register')
│   ├── should register user successfully
│   ├── should integrate with Aleo wallet
│   └── should handle wallet connection errors
├── describe('forward')
│   ├── should verify commitment with Keccak256
│   ├── should use nonce from record
│   ├── should verify ownership
│   ├── should check grace period
│   ├── should handle router migration
│   └── should encode 109-byte forward message
├── describe('refund')
│   ├── should verify ownership
│   ├── should verify expiry
│   └── should allow custom refund recipient
└── describe('waitForDeposit')
```

**Coverage Target**: >95%

---

### 5.2 Integration Tests

**Test Scenarios**:

1. **User Registration**: Register EVM address → Aleo address mapping
2. **Full Flow**: Ethereum → Aleo → Polygon (all token types, with registration)
3. **Multi-Hop**: Ethereum → Aleo → Arbitrum, Arbitrum → Aleo → Optimism
4. **Router Migration**: Upgrade router, verify pending deposits still work
5. **Rebalancing**: Move collateral between chains (using existing infrastructure)
6. **Expiry**: Deposit expires and gets refunded (ownership enforced)
7. **Concurrent Transfers**: 5+ simultaneous transfers for privacy testing
8. **Error Cases**: Unregistered user, wrong secret, expired deposit, insufficient collateral, unauthorized refund

**Test Environment**:

- Anvil (Ethereum fork)
- Aleo devnet
- Mock relayers

---

### 5.3 Privacy Verification Tests

**Critical Tests**:

```typescript
// Test: Amounts not visible on Aleo
async function testAmountPrivacy() {
  // Make transfer with unique amount
  await deposit({ amount: 1234567890 });

  // Get ALL Aleo public state
  const publicState = await getAllAleoMappings('privacy_hub.aleo');

  // Verify amount string doesn't appear anywhere
  assert(!publicState.includes('1234567890'));
}

// Test: Cannot link by amount
async function testUnlinkability() {
  // Two transfers with same amount
  const tx1 = await makePrivateTransfer({
    origin: 'ethereum',
    destination: 'polygon',
    amount: 1000,
  });

  const tx2 = await makePrivateTransfer({
    origin: 'arbitrum',
    destination: 'optimism',
    amount: 1000,
  });

  // Attempt to link
  const canLink = await attemptAmountBasedLinking([tx1, tx2]);

  // Should not be able to definitively link
  assert(canLink.confidence < 0.5);
}

// Test: Commitment security
async function testCommitmentSecurity() {
  const { commitment, secret } = await deposit({
    recipient: '0xBob',
    amount: 1000,
  });

  // Attacker tries to forward with wrong secret
  await expectRevert(
    forward({ commitment, secret: '0xWrongSecret' }),
    'Commitment mismatch',
  );

  // Attacker tries to change recipient
  await expectRevert(
    forward({ commitment, recipient: '0xAttacker' }),
    'Commitment mismatch',
  );

  // Attacker tries to forward without owning record
  await expectRevert(
    forwardAs({ attacker, commitment, secret }),
    'Ownership check failed',
  );
}
```

---

### 5.4 End-to-End CLI Tests

```bash
# Test: Setup wizard
hyperlane privacy setup

# Test: User registration
hyperlane privacy register \
  --origin-chain ethereum \
  --evm-address 0xAlice \
  --aleo-wallet leo

# Test: Full deployment (with proxy pattern)
hyperlane warp deploy --config private-warp-usdc.json

# Test: Send private transfer (checks registration)
hyperlane warp send-private \
  --origin ethereum \
  --destination polygon \
  --recipient 0xBob \
  --amount 1000 \
  --token USDC \
  --commitment-file ./commitment.json

# Test: Forward
hyperlane warp forward \
  --commitment-file ./commitment.json \
  --aleo-wallet leo

# Test: Refund expired
hyperlane warp refund \
  --commitment-file ./commitment.json \
  --refund-recipient 0xAlice \
  --aleo-wallet leo

# Test: Router migration
hyperlane privacy migrate-router \
  --old-router 0xOldRouter \
  --new-router 0xNewRouter

# Test: Rebalance collateral
hyperlane warp rebalance \
  --chain ethereum \
  --destination polygon \
  --amount 10000 \
  --token USDC
```

---

## 6. Deployment Plan

### 6.1 Testnet Deployment (Week 11)

**Chains**:

- Sepolia (Ethereum testnet)
- Mumbai (Polygon testnet)
- Arbitrum Goerli
- Optimism Goerli

**Steps**:

1. Deploy `HypPrivateCollateral` for USDC on all testnets
2. Deploy `privacy_hub.aleo` on Aleo testnet
3. Enroll remote routers
4. Configure relayers
5. Test full flow with real relayers
6. Monitor for 1 week

**Success Metrics**:

- ✅ All transfers complete successfully
- ✅ No stuck transfers
- ✅ Privacy guarantees verified
- ✅ Relayer costs acceptable

---

### 6.2 Mainnet Deployment (Week 13)

**Initial Chains** (Start small, expand gradually):

- Ethereum (USDC collateral)
- Arbitrum (USDC collateral)
- Polygon (USDC collateral)
- Aleo mainnet (privacy hub)

**Deployment Checklist**:

- [ ] Audit complete and findings resolved
- [ ] Bug bounty program live
- [ ] Mainnet contracts deployed
- [ ] Remote routers enrolled
- [ ] Relayers configured and funded
- [ ] Monitoring dashboards setup
- [ ] Alerts configured
- [ ] Documentation published
- [ ] Support channels ready

**Rollout Plan**:

1. **Week 1-2**: Mainnet deployment, small volume testing
2. **Week 3-4**: Gradual volume increase, monitor for issues
3. **Month 2**: Add more chains (Optimism, Base, etc.)
4. **Month 3**: Add more token types (native ETH, synthetic)

---

## 7. Risk Assessment

### 7.1 Technical Risks

| Risk                    | Impact   | Likelihood | Mitigation                                       | Owner            |
| ----------------------- | -------- | ---------- | ------------------------------------------------ | ---------------- |
| Private record leakage  | CRITICAL | LOW        | Aleo's battle-tested encryption, extensive tests | Security Team    |
| Commitment collision    | CRITICAL | VERY LOW   | 256-bit hash + nonce, mathematical analysis      | Protocol Team    |
| Router redirect attack  | CRITICAL | LOW        | Router in commitment, verification on Aleo       | Protocol Team    |
| ISM bypass              | CRITICAL | LOW        | Use existing Hyperlane ISM (battle-tested)       | Integration Team |
| Replay attacks          | HIGH     | LOW        | Track used commitments on all chains             | Protocol Team    |
| Insufficient collateral | HIGH     | MEDIUM     | Movable collateral, monitoring, auto-rebalancing | Ops Team         |
| Gas griefing            | MEDIUM   | MEDIUM     | Gas limits in hooks, rate limiting               | Protocol Team    |
| Aleo network congestion | MEDIUM   | LOW        | Gas price escalation, multiple relayers          | Ops Team         |

### 7.2 Privacy Risks

| Risk                               | Impact | Likelihood | Mitigation                                        | Owner         |
| ---------------------------------- | ------ | ---------- | ------------------------------------------------- | ------------- |
| Statistical inference (low volume) | HIGH   | MEDIUM     | Document limitations, incentivize volume          | Product Team  |
| Timing correlation                 | MEDIUM | MEDIUM     | User-controlled delays, recommend best practices  | Product Team  |
| Metadata analysis                  | MEDIUM | MEDIUM     | Standardize gas, randomize timing                 | Protocol Team |
| Off-chain secret leakage           | HIGH   | MEDIUM     | Secure file handling, encryption at rest          | Security Team |
| Commitment file theft              | HIGH   | MEDIUM     | User education, file encryption, expiry mechanism | Product Team  |
| Network-level correlation          | LOW    | LOW        | Recommend Tor/VPN (out of scope)                  | Docs Team     |

### 7.3 Operational Risks

| Risk                           | Impact | Likelihood | Mitigation                                       | Owner        |
| ------------------------------ | ------ | ---------- | ------------------------------------------------ | ------------ |
| Relayer downtime               | HIGH   | MEDIUM     | Multiple relayers, monitoring, SLAs              | Ops Team     |
| Private record indexer failure | MEDIUM | MEDIUM     | Redundant indexers, fallback to manual provision | Infra Team   |
| User loses commitment file     | LOW    | HIGH       | Expiry + refund mechanism (30 days)              | Product Team |
| Aleo proving service outage    | MEDIUM | LOW        | Fallback proving services, local proving         | Infra Team   |

---

## 8. Appendices

### Appendix A: File Structure

```
hyperlane-monorepo/
├── solidity/
│   ├── contracts/
│   │   └── token/
│   │       └── extensions/
│   │           ├── HypPrivate.sol
│   │           ├── HypPrivateNative.sol
│   │           ├── HypPrivateCollateral.sol
│   │           └── HypPrivateSynthetic.sol
│   └── test/
│       └── token/
│           ├── HypPrivate.t.sol
│           ├── HypPrivateNative.t.sol
│           ├── HypPrivateCollateral.t.sol
│           └── HypPrivateSynthetic.t.sol
│
├── hyperlane-aleo/  (separate repo)
│   └── privacy_hub/
│       ├── src/
│       │   └── main.leo
│       ├── program.json
│       └── tests/
│           ├── integration.test.py
│           ├── privacy.test.py
│           ├── commitment.test.py
│           └── router_enforcement.test.py
│
├── typescript/
│   ├── sdk/
│   │   └── src/
│   │       └── token/
│   │           ├── types.ts
│   │           └── adapters/
│   │               ├── PrivateWarpOriginAdapter.ts
│   │               ├── PrivateWarpOriginAdapter.test.ts
│   │               └── index.ts
│   ├── aleo-sdk/
│   │   └── src/
│   │       ├── AleoPrivacyHubAdapter.ts
│   │       └── AleoPrivacyHubAdapter.test.ts
│   ├── cli/
│   │   └── src/
│   │       ├── commands/
│   │       │   ├── warp-send-private.ts
│   │       │   ├── warp-forward.ts
│   │       │   └── warp-rebalance.ts
│   │       ├── deploy/
│   │       │   └── private-warp.ts
│   │       └── tests/
│   │           └── private-warp.e2e.test.ts
│   ├── widgets/
│   │   └── src/
│   │       └── hooks/
│   │           └── usePrivateTransfer.ts
│   └── infra/
│       └── test/
│           ├── private-warp-integration.test.ts
│           └── privacy-verification.test.ts
│
└── docs/
    ├── privacy-warp-routes.md
    ├── privacy-warp-routes-developer-guide.md
    ├── privacy-warp-routes-security.md
    └── commitment-best-practices.md
```

---

### Appendix B: Commitment Data Format

#### **Commitment File Structure**

```json
{
  "commitment": "0x7f3b2e1a...",
  "secret": "0x9c2d4f5b...",
  "nonce": 42,
  "recipient": "0xRecipientAddress",
  "amount": "1000000000",
  "destinationDomain": 109,
  "destinationRouter": "0xPolygonContractAddress",
  "destination": "polygon",
  "origin": "ethereum",
  "timestamp": 1707696000000,
  "metadata": {
    "tokenSymbol": "USDC",
    "tokenDecimals": 6
  }
}
```

**Note:** The nonce is included in the message body and stored in the private record
on Aleo, so users don't need to provide it when forwarding. The commitment file
primarily stores the secret for verification.

**Security Recommendations**:

- 🔒 Encrypt file at rest (AES-256)
- 🔒 Store in secure location (encrypted filesystem, password manager)
- 🔒 Delete after successful transfer
- 🔒 Never share via unencrypted channels
- 🔒 Backup securely if needed

---

### Appendix C: User Flow Diagrams

#### **Flow 1: Simple Private Transfer**

```
User A on Ethereum → User B on Polygon (1000 USDC)

┌─────────────────┐
│ 1. User A       │
│    Generates    │
│    Secret       │
└────────┬────────┘
         │
         ├─> Secret: 0xabc...
         │
┌────────▼────────┐
│ 2. User A       │
│    Deposits     │
│    on Ethereum  │
└────────┬────────┘
         │
         ├─> ethereum.depositPrivate(secret, Polygon, 0xUserB)
         ├─> 1000 USDC locked
         ├─> Commitment generated
         ├─> Message → Aleo
         │
┌────────▼────────┐
│ 3. Relayer      │
│    Processes    │
│    to Aleo      │
└────────┬────────┘
         │
         ├─> Private record created on Aleo
         ├─> Amount HIDDEN in encrypted record
         │
┌────────▼────────┐
│ 4. User A       │
│    Forwards     │
│    from Aleo    │
└────────┬────────┘
         │
         ├─> aleo.forward(deposit_record, secret)
         ├─> Commitment verified
         ├─> Message → Polygon
         │
┌────────▼────────┐
│ 5. Relayer      │
│    Delivers     │
│    to Polygon   │
└────────┬────────┘
         │
         ├─> polygon._handle(message)
         ├─> 1000 USDC released to User B
         │
┌────────▼────────┐
│ 6. Complete     │
│    ✅ User B    │
│    received     │
│    ❌ No link   │
│    to User A    │
└─────────────────┘

Total Time: 2-5 minutes
User Transactions: 2 (deposit + forward)
```

#### **Flow 2: Split Transfer for Enhanced Privacy**

**Note:** Split transfers are a Phase 2 feature (not in MVP).

For MVP, users can achieve similar results by:

1. Forward deposit to self on intermediate chain
2. Make multiple separate deposits with different amounts
3. Forward each to different final destinations

This provides similar privacy benefits but requires multiple manual steps.

---

### Appendix D: Gas Cost Estimates

**Important:** Costs vary significantly by origin chain. Ethereum L1 is most expensive.
L2s and alt-L1s are much cheaper.

#### Per-Chain Cost Breakdown

**One-Time Setup:**
| Action | Cost | Notes |
|--------|------|-------|
| Aleo wallet setup | Free | One-time |
| Fund Aleo wallet | ~$0.10 | Initial credits |
| Register for privacy | ~$0.005 | One-time Aleo transaction |

**Per Transfer by Origin Chain:**

| Origin Chain      | Deposit Gas | Relayer Fees | Aleo Forward | **Total**        |
| ----------------- | ----------- | ------------ | ------------ | ---------------- |
| **Ethereum (L1)** | $15-65      | $12-14       | $0.02        | **$27-79**       |
| **Arbitrum (L2)** | $0.01-0.10  | $10          | $0.02        | **$10-10.12**    |
| **Optimism (L2)** | $0.01-0.10  | $10          | $0.02        | **$10-10.12**    |
| **Base (L2)**     | $0.01-0.10  | $10          | $0.02        | **$10-10.12**    |
| **Polygon**       | $0.02-0.10  | $10          | $0.02        | **$10-10.12**    |
| **Avalanche**     | $0.50-2.00  | $10          | $0.02        | **$10.52-12.02** |
| **BSC**           | $0.10-0.50  | $10          | $0.02        | **$10.12-10.52** |

**Key Insight:** Privacy cost is dominated by relayer fees (~$10 total for 2 hops),
not origin chain gas. Most chains cost ~$10 total.

#### Comparison to Standard Warp Routes

| Route Type        | Standard | Private  | Premium        |
| ----------------- | -------- | -------- | -------------- |
| Ethereum → Any    | $15-65   | $27-79   | +$12-14        |
| L2/Polygon → Any  | $5-7     | $10-12   | +$5-7          |
| **Typical Route** | **~$6**  | **~$10** | **+$4 (~67%)** |

**Cost Breakdown:**

- Standard route: Origin → Destination (1 relayer = ~$5-7)
- Private route: Origin → Aleo → Destination (2 relayers = ~$10)
- **Privacy premium is the second relayer hop**

**Recommendation:** For cost-sensitive users, use L2/alt-L1 origins (Arbitrum, Polygon, etc.)
instead of Ethereum L1.

---

### Appendix E: Privacy Guarantees

#### **What's Hidden**

| Data                   | On Origin             | On Aleo                       | On Destination             |
| ---------------------- | --------------------- | ----------------------------- | -------------------------- |
| **Sender Address**     | ✅ Visible            | ❌ Hidden (in private record) | ❌ Hidden (Aleo is sender) |
| **Recipient Address**  | ⚠️ In commitment hash | ❌ Hidden (in private record) | ✅ Visible                 |
| **Amount**             | ✅ Visible            | ❌ Hidden (in private record) | ✅ Visible                 |
| **Destination Router** | ⚠️ In commitment      | ❌ Hidden (in private record) | ✅ Visible                 |
| **Commitment**         | ✅ Hash visible       | ✅ Hash visible               | ✅ Hash visible            |
| **Secret**             | ❌ Never on-chain     | ✅ Revealed on forward        | ❌ Not needed              |

#### **Privacy Analysis**

**Scenario**: 5 concurrent transfers

```
Time T=0:
  - Ethereum: User A deposits 1000 USDC (visible)
  - Ethereum: User C deposits 500 USDC (visible)
  - Arbitrum: User E deposits 750 USDC (visible)
  - Polygon: User G deposits 2000 USDC (visible)
  - Optimism: User I deposits 1200 USDC (visible)

Time T=30s (Aleo):
  - [PRIVATE_RECORD_1] amount hidden
  - [PRIVATE_RECORD_2] amount hidden
  - [PRIVATE_RECORD_3] amount hidden
  - [PRIVATE_RECORD_4] amount hidden
  - [PRIVATE_RECORD_5] amount hidden

Time T=60s (Forwarding):
  - [RECORD_?] forwarded (amount still hidden)
  - [RECORD_?] forwarded
  - (Some records not yet forwarded)

Time T=120s (Destinations):
  - Polygon: User B receives 1000 USDC (visible)
  - Optimism: User D receives 500 USDC (visible)
  - (Others still pending)

Can observer link User A → User B?
  ❌ NO - Can't see amounts on Aleo
  ❌ NO - Timing doesn't match (60s vs 120s)
  ❌ NO - Multiple deposits of various amounts
  ❌ NO - Commitments don't reveal participants

Privacy strength: With 5+ concurrent transfers, linkability is probabilistic at best.
```

#### **Privacy Metrics**

| Metric                 | Definition                                      | Target                 |
| ---------------------- | ----------------------------------------------- | ---------------------- |
| **Anonymity Set Size** | Number of concurrent deposits on Aleo           | >5                     |
| **Unlinkability**      | Probability of correct sender-recipient pairing | <20%                   |
| **Amount Correlation** | Can amounts be used to link transfers           | NO (hidden on Aleo)    |
| **Timing Correlation** | Can timing be used to link transfers            | <30% (user-controlled) |

---

### Appendix F: Monitoring & Alerting

#### **Key Metrics to Monitor**

**Aleo Privacy Hub**:

- Number of pending deposits
- Average time from deposit to forward
- Number of expired/refunded deposits
- Used commitments count

**Collateral Balances** (for collateral type):

- Balance on each chain
- Alert if balance < 7 days of average volume
- Rebalancing transaction count

**Privacy Metrics**:

- Concurrent transfer count (anonymity set size)
- Average amount hiding duration
- Timing variance (privacy indicator)

**Security Metrics**:

- Commitment replay attempts (should be 0)
- Invalid router attempts (should be 0)
- Expired deposit count
- Refund transaction count

#### **Alerts**

| Alert             | Severity | Condition               | Action                        |
| ----------------- | -------- | ----------------------- | ----------------------------- |
| Low collateral    | HIGH     | Balance < 7 days volume | Trigger rebalancing           |
| Commitment replay | CRITICAL | Replay attempt detected | Investigate, potential attack |
| Wrong router      | CRITICAL | Router mismatch attempt | Investigate, potential attack |
| High expiry rate  | MEDIUM   | >10% deposits expire    | Review UX, increase expiry    |
| Low anonymity set | LOW      | <3 concurrent transfers | Incentivize volume            |

---

### Appendix G: User Documentation Outline

**1. Introduction**

- What are Privacy Warp Routes?
- How do they differ from standard warp routes?
- Privacy guarantees and limitations

**2. Getting Started**

- Prerequisites
- Supported chains and tokens
- Installation (CLI)

**3. User Guide**

- One-time setup (Aleo wallet + registration)
- Sending private transfers
- Managing commitment files
- Forwarding from Aleo
- Checking transfer status

**4. Developer Guide**

- SDK integration
- Contract deployment
- Configuration
- Testing

**5. Security Best Practices**

- Commitment file security
- Secret generation
- Off-chain communication
- Network privacy (Tor/VPN)

**6. FAQ**

- How private is this really?
- Why do I need an Aleo wallet?
- What if I lose my commitment file?
- What if I lose my Aleo wallet?
- How long do transfers take?
- What are the costs?
- Can I cancel a transfer?
- How does registration work?

**7. Troubleshooting**

- Common issues
- Error messages
- Support channels

---

### Appendix H: Success Criteria Summary

#### **Functional Requirements (MVP)**

- ✅ Single contract per chain (send + receive)
- ✅ All token types supported (native, collateral, synthetic)
- ✅ Commitment-based verification with Keccak256
- ✅ Destination router enforcement with migration support
- ✅ Movable collateral for rebalancing (existing infrastructure)
- ✅ Full flow works: Origin → Aleo → Destination
- ✅ User registration system (EVM address → Aleo address)
- ✅ Expiry and refunds work with ownership checks
- ✅ CLI deployment works
- ✅ CLI registration works
- ✅ CLI send-private works
- ✅ CLI forward works
- ✅ SDK adapters complete (split by blockchain)
- ✅ Upgradeable router contracts (proxy pattern)
- ⚠️ Split transfers (Phase 2 feature)

#### **Privacy Requirements**

- ✅ Amounts hidden on Aleo (verified by automated test)
- ✅ Sender-recipient unlinkability (verified by automated test)
- ✅ No public state leakage on Aleo (private records only)
- ✅ Commitment doesn't reveal participants
- ✅ Replay attacks prevented
- ✅ Privacy guarantees documented
- ⚠️ Privacy limitations clearly documented (volume-dependent)
- ⚠️ Users informed of privacy trade-offs at low volume

#### **Testing Requirements**

- ✅ >95% unit test coverage (Solidity)
- ✅ >90% unit test coverage (Leo)
- ✅ >95% unit test coverage (TypeScript)
- ✅ >85% unit test coverage (CLI)
- ✅ All integration tests pass
- ✅ All E2E tests pass
- ✅ Privacy verification tests pass
- ✅ Commitment security tests pass

#### **Security Requirements**

- ✅ Internal security review complete
- ✅ External audit complete
- ✅ All critical findings resolved
- ✅ All high findings resolved
- ✅ Bug bounty program live
- ✅ No critical issues in first month of mainnet

#### **Documentation Requirements**

- ✅ User documentation complete
- ✅ Developer documentation complete
- ✅ API reference published
- ✅ Example integrations provided
- ✅ Security best practices documented
- ✅ Commitment handling guide

---

### Appendix I: Timeline

```
Week 1:  ████████░░ Base Contract + Native Token
Week 2:  ████████░░ Collateral Token + Rebalancing
Week 3:  ████████░░ Synthetic Token
Week 4:  ████████░░ EVM Integration Testing
Week 5:  ████████░░ Aleo Privacy Hub Core
Week 6:  ████████░░ Aleo Advanced Features + Testing
Week 7:  ████████░░ Origin Adapter + Tests
Week 8:  ████████░░ Aleo Hub Adapter + Tests
Week 9:  ████████░░ CLI Integration + E2E Tests
Week 10: ████████░░ Comprehensive Testing
Week 11: ████████░░ Security Audit Prep + Testnet
Week 12: ████████░░ External Audit
Week 13: ████████░░ Documentation + Mainnet Launch

Total: 13 weeks
```

---

### Appendix J: References

**Aleo Resources**:

- [Aleo Official Website](https://aleo.org/)
- [Aleo Developer Documentation](https://developer.aleo.org/)
- [Leo Programming Language](https://docs.leo-lang.org/)
- [Aleo Records Guide](https://developer.aleo.org/concepts/fundamentals/records/)
- [zkSNARK Introduction](https://developer.aleo.org/concepts/advanced/intro_to_zksnark/)

**Hyperlane Resources**:

- [Hyperlane Documentation](https://docs.hyperlane.xyz)
- [Warp Routes Guide](https://docs.hyperlane.xyz/docs/guides/quickstart/deploy-warp-route)
- [Hyperlane GitHub](https://github.com/hyperlane-xyz/hyperlane-monorepo)

**Privacy Research**:

- [Privacy-Preserving Cross-Chain Interoperability](https://chain.link/article/privacy-preserving-cross-chain-interoperability)
- [Zero-Knowledge Bridges](https://tokenminds.co/blog/zero-knowledge-bridges)
- [How Records Work in Aleo](https://medium.com/veridise/how-records-work-in-aleo-the-foundation-of-private-state-in-leo-33fd20d4866b)

---

### Appendix K: Key Changes from Original Plan

**This section documents critical fixes applied after technical review:**

| Issue                | Original Design                | Updated Design                           | Reason                                                      |
| -------------------- | ------------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| **Hash Function**    | BHP256                         | Keccak256                                | Compatibility with Solidity, system wouldn't work otherwise |
| **Nonce Handling**   | Extract from commitment        | Pass in message body + store in record   | Impossible to extract from hash                             |
| **Loop Bounds**      | Variable (`for i in 0..count`) | Fixed bounds with conditionals           | Leo language constraint                                     |
| **Aleo Address**     | try_map_to_aleo_address        | User registration system                 | No cryptographic mapping exists                             |
| **Amount Type**      | u128                           | [u128; 2] (u256)                         | Full 256-bit compatibility with Solidity                    |
| **Message Encoding** | abi.encode                     | abi.encodePacked + padding               | Aleo fixed-size array compatibility                         |
| **Message Lengths**  | Variable                       | 141 bytes (deposit), 109 bytes (forward) | Aleo supported lengths only                                 |
| **Token Flow**       | Unclear                        | Documented clearly                       | Aleo is message relay, not liquidity pool                   |
| **Privacy Claims**   | Strong by default              | Volume-dependent                         | Realistic at launch                                         |
| **User Flow**        | 1 wallet implied               | 2 wallets required                       | Aleo wallet needed for self-custody                         |
| **Cost Estimates**   | Ethereum-only                  | Multi-chain table                        | Most chains much cheaper than Ethereum                      |
| **Refund Security**  | No ownership check             | deposit.owner == self.signer             | Prevents unauthorized refunds                               |
| **Split Transfers**  | MVP feature                    | Phase 2 only                             | Leo constraints make complex                                |
| **Nonce Storage**    | Commitment file                | Private record field                     | Simpler UX, more private                                    |
| **Router Upgrades**  | Not addressed                  | Proxy + migration mapping                | Prevents stuck funds                                        |
| **Expiry Grace**     | None                           | 10 blocks (~50s)                         | Prevents race conditions                                    |

**Critical Security Additions:**

- ✅ Ownership checks on forward and refund (prevents unauthorized access)
- ✅ Router migration system (handles upgrades gracefully)
- ✅ User registration (self-custody without custodians)
- ✅ Keccak256 for cross-platform compatibility
- ✅ Proper message encoding/decoding with endianness handling

**MVP Scope Changes:**

- ➖ Removed: Split transfers (Phase 2 feature)
- ➕ Added: User registration system
- ➕ Added: Router migration support
- ➕ Added: Setup wizard and improved CLI UX
- ➕ Added: Ownership security checks

---

## Conclusion

This implementation plan provides a complete roadmap for building privacy-enhanced cross-chain token transfers using Aleo as a privacy middleware. The system is designed to be:

- **Secure**: Commitment-based verification, replay prevention, router enforcement, ownership checks
- **Private**: Amounts hidden on Aleo, sender-recipient unlinkability (volume-dependent)
- **Practical**: Works with existing Hyperlane infrastructure and rebalancing
- **Flexible**: Supports all token types, all VMs
- **Self-Custody**: User registration with Aleo wallet (no custodians)
- **Maintainable**: Router upgrades supported via proxy pattern + migration

The 13-week timeline includes all development, testing, auditing, and deployment phases, resulting in a production-ready privacy solution for the Hyperlane ecosystem.

**Key Technical Achievements:**

- ✅ Cross-VM compatibility (EVM ↔ Aleo message encoding)
- ✅ Full uint256 amount support via [u128; 2] representation
- ✅ Self-custody without custodial services
- ✅ Graceful router upgrade path
- ✅ Comprehensive security model with ownership enforcement

---

**Document Version**: 1.1
**Last Updated**: 2026-02-12
**Status**: Updated with Critical Fixes - Ready for Implementation
**Next Step**: Begin Week 1 - Base Contract Implementation
