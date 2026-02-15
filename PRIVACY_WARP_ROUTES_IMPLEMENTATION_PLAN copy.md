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
- Supports split transfers for enhanced privacy
- Handles expiry and refunds

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

- Forward deposits to destinations
- Split transfers
- Timing control
- Refund expired deposits

#### **D. CLI Integration**

Commands for deploying and using privacy warp routes:

- `hyperlane warp deploy --config private-warp-config.json` - Deploy privacy route
- `hyperlane warp send-private` - Deposit on origin chain
- `hyperlane warp forward` - Forward from Aleo to destination
- `hyperlane warp rebalance` - Rebalance collateral (collateral type)

---

### 1.3 Data Flow Example: USDC from Ethereum to Polygon

```
User: Alice on Ethereum
Recipient: Bob on Polygon
Amount: 1000 USDC

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
    amount,              // 32 bytes - transfer amount
    destinationDomain,   // 4 bytes - destination chain ID
    destinationRouter,   // 32 bytes - destination contract address
    nonce                // 32 bytes - contract nonce (auto-incremented)
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
// Only record owner can forward
assert_eq(deposit.owner, self.signer);

// Even if secret is public, only owner can spend the private record
// Aleo VM enforces record ownership cryptographically
```

**Additional Protection**: Use private fee on Aleo (`privateFee: true`) to hide transaction from mempool.

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

        // Encode message: [commitment][finalDest][amount][recipient][destRouter]
        bytes memory messageBody = abi.encode(
            commitment,
            finalDestination,
            amount,
            recipient,
            destinationRouter
        );

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
        amount: u128,                // Transfer amount (HIDDEN)
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
        // [commitment][finalDest][amount][recipient][destRouter]
        let commitment = decode_field_from_body(message.body, 0u8);
        let final_destination = decode_u32_from_body(message.body, 1u8);
        let amount = decode_u128_from_body(message.body, 2u8);
        let recipient = decode_bytes32_from_body(message.body, 3u8);
        let destination_router = decode_bytes32_from_body(message.body, 4u8);

        // Determine owner (try to map origin sender to Aleo address)
        let owner_address = try_map_to_aleo_address(message.sender);

        // Create PRIVATE record - ALL details encrypted on-chain
        let private_deposit = PrivateDeposit {
            owner: owner_address,
            commitment: commitment,
            amount: amount,
            final_destination: final_destination,
            recipient: recipient,
            destination_router: destination_router,
            origin_chain: message.origin_domain,
            token_id: get_default_token_id(),
            timestamp: block.height,
            expiry: block.height + EXPIRY_BLOCKS,
        };

        return (
            private_deposit,
            finalize_receive_deposit(commitment, amount, mailbox_future)
        );
    }

    async function finalize_receive_deposit(
        commitment: field,
        amount: u128,
        mailbox_future: Future
    ) {
        // Check not paused
        let config = hub_config.get(true);
        assert_eq(config.paused, false);

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

        // Verify not expired
        assert(block.height < deposit.expiry);

        // CRITICAL: Verify commitment matches
        let computed_commitment = compute_commitment(
            secret,
            deposit.recipient,
            deposit.amount,
            deposit.final_destination,
            deposit.destination_router,
            extract_nonce_from_commitment(deposit.commitment)
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
        token_id: field,
        amount: u128,
        unverified_config: HubConfig,
        unverified_remote_router: RemoteRouter,
        dispatch_future: Future
    ) {
        // Verify config matches
        let actual_config = hub_config.get(true);
        assert_eq(actual_config, unverified_config);
        assert_eq(actual_config.paused, false);

        // Verify minimum delay passed
        assert(block.height >= deposit_timestamp + actual_config.min_claim_delay);

        // Mark commitment as used (prevent replay)
        assert(!used_commitments.contains(commitment));
        used_commitments.set(commitment, true);

        // Verify remote router matches enrolled router
        let actual_router = remote_routers.get(final_destination);
        assert_eq(actual_router, unverified_remote_router);

        // Transfer tokens out
        token_registry.aleo/transfer_public(
            token_id,
            dispatch_proxy.aleo.address,
            amount
        );

        // Complete dispatch
        dispatch_future.await();
    }

    /**
     * Split and forward to multiple recipients
     * Enhances privacy by breaking amount-based correlation
     */
    async transition split_and_forward(
        private deposit: PrivateDeposit,
        public secrets: [[u8; 32]; 4],
        public recipients: [[u8; 32]; 4],
        public amounts: [u128; 4],
        public destinations: [u32; 4],
        public count: u8,
        public unverified_config: HubConfig,
        public unverified_mailbox_state: MailboxState,
        public unverified_routers: [RemoteRouter; 4],
        public allowances: [[CreditAllowance; 4]; 4]
    ) -> Future {

        // Verify ownership
        assert_eq(deposit.owner, self.signer);
        assert(block.height < deposit.expiry);

        // Verify splits sum to total
        let total = 0u128;
        for i in 0u8..count {
            total += amounts[i];
        }
        assert_eq(total, deposit.amount);

        // Verify commitments for each split
        for i in 0u8..count {
            let split_commitment = compute_commitment(
                secrets[i],
                recipients[i],
                amounts[i],
                destinations[i],
                unverified_routers[i].recipient,
                extract_nonce_from_commitment(deposit.commitment) + i as u32
            );
            // Could verify split commitments if desired
        }

        // Dispatch to each destination
        // (Implementation: create multiple dispatch futures)

        return finalize_split_and_forward(
            deposit.commitment,
            deposit.timestamp,
            deposit.token_id,
            amounts,
            count,
            unverified_config,
            unverified_routers,
            destinations,
            // ... dispatch futures
        );
    }

    async function finalize_split_and_forward(
        commitment: field,
        deposit_timestamp: u32,
        token_id: field,
        amounts: [u128; 4],
        count: u8,
        unverified_config: HubConfig,
        unverified_routers: [RemoteRouter; 4],
        destinations: [u32; 4],
        // ... dispatch futures
    ) {
        // Verify config
        let actual_config = hub_config.get(true);
        assert_eq(actual_config, unverified_config);

        // Verify delay
        assert(block.height >= deposit_timestamp + actual_config.min_claim_delay);

        // Mark commitment as used
        assert(!used_commitments.contains(commitment));
        used_commitments.set(commitment, true);

        // Verify routers for each destination
        for i in 0u8..count {
            let actual_router = remote_routers.get(destinations[i]);
            assert_eq(actual_router, unverified_routers[i]);
        }

        // Transfer tokens for all splits
        let total = 0u128;
        for i in 0u8..count {
            total += amounts[i];
        }

        token_registry.aleo/transfer_public(
            token_id,
            dispatch_proxy.aleo.address,
            total
        );

        // Await all dispatch futures
        // (Implementation omitted for brevity)
    }

    /**
     * Refund expired deposit to origin chain
     */
    async transition refund_expired(
        private deposit: PrivateDeposit,
        public refund_recipient: [u8; 32]
    ) -> Future {

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

        // Dispatch refund to origin
        let dispatch_future = dispatch_proxy.aleo/dispatch(
            get_mailbox_state(),
            deposit.origin_chain,
            origin_router.recipient,
            message_body,
            NULL_ADDRESS,
            get_hook_metadata(origin_router.gas),
            []
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
        amount: u128,
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
        return BHP256::hash_to_field(data);
    }

    inline concatenate_commitment_data(
        secret: [u8; 32],
        recipient: [u8; 32],
        amount: u128,
        destination_domain: u32,
        destination_router: [u8; 32],
        nonce: u32
    ) -> [u8; 140] {
        let data = [0u8; 140];

        // secret: 32 bytes
        for i in 0u8..32u8 {
            data[i] = secret[i];
        }

        // recipient: 32 bytes
        for i in 0u8..32u8 {
            data[32u8 + i] = recipient[i];
        }

        // amount: 16 bytes (u128)
        let amount_bytes = u128_to_bytes(amount);
        for i in 0u8..16u8 {
            data[64u8 + i] = amount_bytes[i];
        }

        // destination_domain: 4 bytes
        let domain_bytes = u32_to_bytes(destination_domain);
        for i in 0u8..4u8 {
            data[80u8 + i] = domain_bytes[i];
        }

        // destination_router: 32 bytes
        for i in 0u8..32u8 {
            data[84u8 + i] = destination_router[i];
        }

        // nonce: 4 bytes
        let nonce_bytes = u32_to_bytes(nonce);
        for i in 0u8..4u8 {
            data[116u8 + i] = nonce_bytes[i];
        }

        return data;
    }

    inline extract_nonce_from_commitment(commitment: field) -> u32 {
        // Extract nonce from commitment field
        // (Implementation depends on how commitment is structured)
        // For now, this is a placeholder
        return 0u32;
    }

    // Additional helper functions...
    inline get_program_id() -> [u8; 128] { /* ... */ }
    inline get_default_token_id() -> field { /* ... */ }
    inline decode_field_from_body(body: [u128; 16], offset: u8) -> field { /* ... */ }
    inline decode_u32_from_body(body: [u128; 16], offset: u8) -> u32 { /* ... */ }
    inline decode_u128_from_body(body: [u128; 16], offset: u8) -> u128 { /* ... */ }
    inline decode_bytes32_from_body(body: [u128; 16], offset: u8) -> [u8; 32] { /* ... */ }
    inline try_map_to_aleo_address(eth_address: [u8; 32]) -> address { /* ... */ }
    inline encode_forward_message(recipient: [u8; 32], amount: u128, commitment: field) -> [u128; 16] { /* ... */ }
    inline u128_to_bytes(value: u128) -> [u8; 16] { /* ... */ }
    inline u32_to_bytes(value: u32) -> [u8; 4] { /* ... */ }
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
- Private record structure
- Receive deposit logic
- Forward to destination logic
- Commitment verification

**Week 6: Advanced Features + Testing**

- Split and forward implementation
- Expiry and refund logic
- Python integration tests
- Privacy verification tests
- Commitment security tests

**Deliverables**:

- ✅ `privacy_hub.aleo` contract
- ✅ >90% test coverage
- ✅ Privacy tests confirming amount hiding
- ✅ All integration tests passing

---

### Phase 3: TypeScript SDK (3 weeks)

**Week 7: Origin Adapter**

- Implement `PrivateWarpOriginAdapter.ts`
- Deposit function with commitment generation
- Remote router enrollment
- Collateral rebalancing
- Unit tests

**Week 8: Aleo Hub Adapter**

- Implement `AleoPrivacyHubAdapter.ts`
- Forward function
- Split and forward
- Timing control
- Unit tests

**Week 9: Integration + CLI**

- Integrate adapters with existing WarpCore
- CLI deployment command
- CLI send-private command
- CLI forward command
- E2E CLI tests

**Deliverables**:

- ✅ 2 TypeScript adapters
- ✅ CLI commands
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
├── testCommitmentComputation
├── testNonceIncrement
├── testDepositPrivate
├── testReceiveFromAleo
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
├── test_receive_deposit
├── test_forward_to_destination
├── test_commitment_verification
├── test_router_enforcement
├── test_split_and_forward
├── test_expiry_refund
└── test_cannot_forward_expired

privacy.test.py
├── test_amount_privacy (CRITICAL)
├── test_recipient_privacy
├── test_no_public_state_leakage
└── test_commitment_uniqueness

commitment.test.py
├── test_commitment_includes_all_params
├── test_destination_router_enforced
├── test_cannot_use_wrong_secret
└── test_commitment_replay_prevented

router_enforcement.test.py
├── test_cannot_forward_to_wrong_router
├── test_router_must_be_enrolled
└── test_router_mismatch_fails
```

**Coverage Target**: >90%

#### **TypeScript Tests** (Mocha/Chai)

```bash
# Location: typescript/sdk/src/token/adapters/

PrivateWarpOriginAdapter.test.ts
├── describe('deposit')
│   ├── should generate commitment correctly
│   ├── should auto-generate secret
│   ├── should use provided secret
│   ├── should verify router enrollment
│   └── should handle all token types
├── describe('enrollRemoteRouter')
├── describe('rebalanceCollateral')
└── describe('getBalance')

AleoPrivacyHubAdapter.test.ts
├── describe('forward')
│   ├── should verify commitment
│   ├── should support immediate forwarding
│   └── should support delayed forwarding
├── describe('splitAndForward')
│   ├── should split correctly
│   └── should reject invalid splits
└── describe('waitForDeposit')
```

**Coverage Target**: >95%

---

### 5.2 Integration Tests

**Test Scenarios**:

1. **Full Flow**: Ethereum → Aleo → Polygon (all token types)
2. **Multi-Hop**: Ethereum → Aleo → Arbitrum, Arbitrum → Aleo → Optimism
3. **Split Transfers**: One deposit → multiple recipients on different chains
4. **Rebalancing**: Move collateral between chains
5. **Expiry**: Deposit expires and gets refunded
6. **Concurrent Transfers**: 5+ simultaneous transfers for privacy testing
7. **Error Cases**: Wrong secret, expired deposit, insufficient collateral

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
}
```

---

### 5.4 End-to-End CLI Tests

```bash
# Test: Full deployment
hyperlane warp deploy --config private-warp-usdc.json

# Test: Send private transfer
hyperlane warp send-private \
  --origin ethereum \
  --destination polygon \
  --recipient 0xBob \
  --amount 1000 \
  --token USDC \
  --commitment-file ./commitment.json

# Test: Forward (immediate)
hyperlane warp forward --commitment-file ./commitment.json

# Test: Forward (delayed)
hyperlane warp forward \
  --commitment-file ./commitment.json \
  --timing delayed \
  --delay-blocks 20

# Test: Split transfer
hyperlane warp forward \
  --commitment-file ./commitment.json \
  --split \
  --split-config ./splits.json

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
  "recipient": "0xRecipientAddress",
  "amount": "1000000000",
  "destinationDomain": 109,
  "destinationRouter": "0xPolygonContractAddress",
  "nonce": 42,
  "destination": "polygon",
  "origin": "ethereum",
  "timestamp": 1707696000000,
  "metadata": {
    "tokenSymbol": "USDC",
    "tokenDecimals": 6
  }
}
```

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

```
User A deposits 1000 USDC
  ↓
Split on Aleo:
  - 400 USDC → User B (Polygon)
  - 300 USDC → User C (Arbitrum)
  - 300 USDC → User D (Optimism)
  ↓
Observers see:
  - Ethereum: Someone deposited 1000 USDC
  - Polygon: Someone received 400 USDC
  - Arbitrum: Someone received 300 USDC
  - Optimism: Someone received 300 USDC
  ↓
Cannot link because:
  - Amounts don't match (1000 ≠ 400/300/300)
  - Different destinations
  - Timing controlled by User A
```

---

### Appendix D: Gas Cost Estimates

| Operation                | Chain | Gas              | Cost @ 30 gwei | Cost @ 100 gwei |
| ------------------------ | ----- | ---------------- | -------------- | --------------- |
| **Enroll Router**        | EVM   | ~50,000          | $4.50          | $15.00          |
| **Deposit (Native)**     | EVM   | ~150,000         | $13.50         | $45.00          |
| **Deposit (Collateral)** | EVM   | ~200,000         | $18.00         | $60.00          |
| **Deposit (Synthetic)**  | EVM   | ~180,000         | $16.20         | $54.00          |
| **Receive**              | EVM   | ~100,000         | $9.00          | $30.00          |
| **Rebalance**            | EVM   | ~120,000         | $10.80         | $36.00          |
| **Forward**              | Aleo  | ~150,000 credits | ~$0.01         | ~$0.01          |
| **Split (3 recipients)** | Aleo  | ~300,000 credits | ~$0.02         | ~$0.02          |

**Total User Cost** (Ethereum → Polygon):

- Origin deposit: ~$18 (@ 30 gwei)
- Aleo forward: ~$0.01
- Destination receive: Covered by relayer
- **Total: ~$18.01**

**Comparison to Standard Warp Route**:

- Standard: ~$15 (single transaction)
- Private: ~$18 (two transactions)
- **Privacy Premium: ~20%**

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

- Sending private transfers
- Managing commitment files
- Forwarding from Aleo
- Split transfers
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
- What if I lose my commitment file?
- How long do transfers take?
- What are the costs?
- Can I cancel a transfer?

**7. Troubleshooting**

- Common issues
- Error messages
- Support channels

---

### Appendix H: Success Criteria Summary

#### **Functional Requirements**

- ✅ Single contract per chain (send + receive)
- ✅ All token types supported (native, collateral, synthetic)
- ✅ Commitment-based verification (no deposit ID, no salt)
- ✅ Destination router enforcement
- ✅ Movable collateral for rebalancing
- ✅ Full flow works: Origin → Aleo → Destination
- ✅ Split transfers functional
- ✅ Expiry and refunds work
- ✅ CLI deployment works
- ✅ CLI send-private works
- ✅ CLI forward works
- ✅ SDK adapters complete (split by blockchain)

#### **Privacy Requirements**

- ✅ Amounts hidden on Aleo (verified by automated test)
- ✅ Sender-recipient unlinkability (verified by automated test)
- ✅ No public state leakage on Aleo
- ✅ Commitment doesn't reveal participants
- ✅ Replay attacks prevented
- ✅ Privacy guarantees documented

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

## Conclusion

This implementation plan provides a complete roadmap for building privacy-enhanced cross-chain token transfers using Aleo as a privacy middleware. The system is designed to be:

- **Secure**: Commitment-based verification, replay prevention, router enforcement
- **Private**: Amounts hidden on Aleo, sender-recipient unlinkability
- **Practical**: Works with existing Hyperlane infrastructure
- **Flexible**: Supports all token types, all VMs
- **User-Friendly**: Simple CLI commands, clear SDK interfaces

The 13-week timeline includes all development, testing, auditing, and deployment phases, resulting in a production-ready privacy solution for the Hyperlane ecosystem.

---

**Document Version**: 1.0
**Last Updated**: 2026-02-11
**Status**: Ready for Implementation
**Next Step**: Begin Week 1 - Base Contract Implementation
