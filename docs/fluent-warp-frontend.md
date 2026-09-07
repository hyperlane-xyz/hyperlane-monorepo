# Fluent Native ETH Warp — Frontend Integration

Two-way native ETH bridge between **Fluent L2** and any Hyperlane-supported chain. Frontend hits two contract types:

- **`L2HypNativeGateway`** on Fluent L2 — for **outbound** (L2 → peer).
- Standard **`HypNative` warp route** on each peer chain — for **inbound** (peer → L2).

Fluent L2 itself is _not_ a Hyperlane domain. Sender on peer specifies destination `11155111` (Ethereum) + L2 address as recipient; the L1 hub auto-forwards to Fluent L2.

---

## Domain IDs

| Chain            | Hyperlane domain |
| ---------------- | ---------------- |
| Ethereum Sepolia | `11155111`       |
| Arbitrum Sepolia | `421614`         |
| Solana Devnet    | TBD              |

## Addresses (testnet)

| Contract                   | Chain       | Address                                      |
| -------------------------- | ----------- | -------------------------------------------- |
| `L2HypNativeGateway`       | Fluent L2   | `0xe3f87C557c51b296DbC886De05744f0D52ecBb77` |
| `L1FluentHypNative` (warp) | Sepolia     | `0x6197dC5A4E021B0c2A67334D94704425f87374A7` |
| `HypNative` (peer)         | Arb Sepolia | `0xC5790c39284BBd0a0707c553fE6d782948c11ED8` |

---

## Outbound: Fluent L2 → peer

```solidity
// L2HypNativeGateway
function sendNativeTokens(
    uint32  domain,     // peer's Hyperlane domain (e.g. 421614)
    bytes32 recipient,  // peer-side address as bytes32
    uint256 amount,     // exact-out ETH at the recipient
    uint256 hypFee      // Hyperlane fee budget for L1 dispatch (>= 0.001 ether)
) external payable;

uint256 public constant MIN_HYP_FEE_NATIVE = 0.001 ether;
```

`msg.value = amount + hypFee + bridgeFee`

- `bridgeFee = FluentBridge.getSentMessageFee()` — read live.
- Excess is **not refunded**, it goes to the L1 fee reserve.
- `hypFee` is a floor; if the live L1 quote is higher, the gateway tops up from its reserve.

Recipient encoding for EVM peer:

```ts
const recipient32 = ethers.zeroPadValue(addr, 32);
```

Event:

```solidity
event NativeTransferInitiated(
    uint32 indexed domain,
    bytes32 indexed recipient,
    uint256 amount,
    address sender,
    uint256 hypFee,
    uint256 bridgeFee
);
```

---

## Inbound: peer → Fluent L2

Standard Hyperlane `HypNative` on the peer. Destination is **always `11155111`** (Sepolia), recipient is the **L2 address**.

```solidity
// HypNative (peer chain)
function transferRemote(
    uint32  destination,  // 11155111
    bytes32 recipient,    // L2 address as bytes32
    uint256 amount
) external payable returns (bytes32 messageId);

function quoteGasPayment(uint32 destination) external view returns (uint256);
```

`msg.value = amount + quoteGasPayment(11155111)`

ETA: ~1–3 min (Hyperlane relay + Fluent bridge to L2).

Events:

```solidity
event SentTransferRemote(uint32 indexed destination, bytes32 indexed recipient, uint256 amount);
// On L2 once delivered:
event ReceivedTokens(address indexed from, address indexed to, uint256 amount);
```

---

## Tracking a transfer

1. Outbound L2: filter `NativeTransferInitiated` on `L2HypNativeGateway`.
2. Inbound L2: filter `ReceivedTokens` on `L2HypNativeGateway`, match by `to` + `amount`.
3. For peer ↔ L2 in either direction, the Hyperlane Explorer (`explorer.hyperlane.xyz`) can resolve a `messageId` to delivery status.

## Errors to surface

L2 gateway reverts:

| Error                 | Cause                           | UX                          |
| --------------------- | ------------------------------- | --------------------------- |
| `InvalidTargetDomain` | `domain == 0`                   | Bad config                  |
| `ZeroRecipient`       | `recipient == 0`                | Bad input                   |
| `InvalidHyperlaneFee` | `hypFee < MIN_HYP_FEE_NATIVE`   | Raise fee, retry            |
| `InvalidNativeAmount` | `msg.value < required`          | Re-quote `bridgeFee`, retry |
| `AccountBlacklisted`  | Sender or recipient blacklisted | Show "address not eligible" |
