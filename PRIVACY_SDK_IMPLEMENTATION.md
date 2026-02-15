# Privacy Warp Routes - TypeScript SDK Implementation

## Overview

This document describes the TypeScript SDK implementation for privacy-enhanced warp routes using Aleo as a privacy middleware.

## Architecture

```
EVM Origin Chain (Alice deposits)
    ↓ Message (141 bytes)
Aleo Privacy Hub (Private record created)
    ↓ Message (109 bytes)
EVM Destination Chain (Bob receives)
```

## Files Created

### 1. Token Type Definitions

**File:** `/typescript/sdk/src/token/config.ts`

Added new token types:

- `privateNative` - Privacy-enhanced native token transfers
- `privateCollateral` - Privacy-enhanced ERC20 transfers with collateral
- `privateSynthetic` - Privacy-enhanced synthetic token transfers

**File:** `/typescript/sdk/src/token/types.ts`

Added configuration schemas:

- `PrivateWarpConfigSchema` - Common config for all privacy types
- `PrivateNativeConfigSchema` - Native token privacy config
- `PrivateCollateralConfigSchema` - Collateral token privacy config
- `PrivateSyntheticConfigSchema` - Synthetic token privacy config

### 2. Origin Chain Adapter

**File:** `/typescript/sdk/src/token/adapters/PrivateWarpOriginAdapter.ts`

Classes:

- `BasePrivateWarpOriginAdapter` - Base class for EVM origin operations
- `EvmHypPrivateNativeAdapter` - Native token deposits
- `EvmHypPrivateCollateralAdapter` - ERC20 token deposits
- `EvmHypPrivateSyntheticAdapter` - Synthetic token deposits

Key methods:

```typescript
// Compute commitment (matches Solidity)
computeCommitment(
  secret: string,
  recipient: string,
  amount: bigint,
  destinationDomain: number,
  destinationRouter: string,
  nonce: number
): string

// Check user registration status
checkRegistration(
  originChain: number,
  originAddress: Address
): Promise<UserRegistrationInfo>

// Deposit tokens for private transfer
populateDepositPrivateTx(
  params: PrivateDepositParams
): Promise<{ tx: PopulatedTransaction; commitment: string; nonce: number }>

// Get current nonce
getCurrentNonce(): Promise<number>

// Check if commitment used
isCommitmentUsed(commitment: string): Promise<boolean>

// Get remote router
getRemoteRouter(domain: Domain): Promise<string>

// Enroll remote router (owner only)
populateEnrollRemoteRouterTx(domain: Domain, router: string): Promise<PopulatedTransaction>

// Get collateral balance (collateral only)
getCollateralBalance(): Promise<bigint>

// Transfer collateral for rebalancing (collateral only)
populateTransferRemoteCollateralTx(destination: Domain, amount: bigint): Promise<PopulatedTransaction>
```

### 3. Aleo Privacy Hub Adapter

**File:** `/typescript/sdk/src/token/adapters/AleoPrivacyHubAdapter.ts`

Class: `AleoPrivacyHubAdapter`

Key methods:

```typescript
// Register user on Aleo
populateRegisterUserTx(
  params: RegistrationParams,
  aleoWallet: AleoWalletInterface
): Promise<AleoTransaction>

// Check if user registered
isUserRegistered(originChain: number, originAddress: Uint8Array): Promise<boolean>

// Get registered Aleo address
getRegisteredAleoAddress(originChain: number, originAddress: Uint8Array): Promise<string | null>

// Forward deposit to destination
populateForwardToDestinationTx(
  params: ForwardParams,
  aleoWallet: AleoWalletInterface
): Promise<AleoTransaction>

// Refund expired deposit
populateRefundExpiredTx(
  params: RefundParams,
  aleoWallet: AleoWalletInterface
): Promise<AleoTransaction>

// Get hub configuration
getHubConfig(): Promise<HubConfig>

// Get remote router
getRemoteRouter(domain: Domain): Promise<RemoteRouter | null>

// Check if commitment used
isCommitmentUsed(commitment: string): Promise<boolean>
```

### 4. Usage Examples

**File:** `/typescript/sdk/src/token/adapters/PrivateWarpUsageExample.ts`

Example functions:

- `registerUser()` - Register on Aleo
- `depositPrivate()` - Deposit on origin chain
- `forwardToDestination()` - Forward via Aleo
- `refundExpired()` - Refund expired deposits
- `completePrivateTransferFlow()` - Full flow documentation

## Usage Flow

### Step 1: User Registration

Users must register their EVM address with an Aleo address before depositing:

```typescript
import { registerUser } from './PrivateWarpUsageExample';

const aleoWallet = new LeoWallet(); // or PuzzleWallet
await registerUser(
  multiProvider,
  'ethereum',
  '0x123...', // EVM address
  aleoWallet,
);
```

### Step 2: Deposit on Origin Chain

```typescript
import { EvmHypPrivateNativeAdapter } from './PrivateWarpOriginAdapter';

const adapter = new EvmHypPrivateNativeAdapter('ethereum', multiProvider, {
  token: '0xPrivateNativeAddress...',
});

// Generate secret (KEEP SECURE!)
const secret = ethers.utils.hexlify(ethers.utils.randomBytes(32));

// Prepare deposit
const { tx, commitment, nonce } = await adapter.populateDepositPrivateTx({
  secret,
  finalDestination: 137, // Polygon domain
  recipient: '0xBob...',
  amount: ethers.utils.parseEther('1.0'),
});

// Submit transaction
const txResponse = await signer.sendTransaction(tx);
await txResponse.wait();

// Save commitment info
console.log('Commitment:', commitment);
console.log('Nonce:', nonce);
console.log('Secret:', secret); // KEEP SECRET!
```

### Step 3: Forward via Aleo

```typescript
import { AleoPrivacyHubAdapter } from './AleoPrivacyHubAdapter';

const aleoAdapter = new AleoPrivacyHubAdapter('aleo', multiProvider, {
  privacyHub: 'privacy_hub.aleo',
});

// Get deposit record (from Aleo wallet/indexer)
const depositRecord = await getDepositRecord(commitment);

// Forward to destination
const forwardTx = await aleoAdapter.populateForwardToDestinationTx(
  {
    deposit: depositRecord,
    secret: secretBytes,
    unverifiedConfig: await aleoAdapter.getHubConfig(),
    unverifiedMailboxState: mailboxState,
    unverifiedRemoteRouter:
      await aleoAdapter.getRemoteRouter(destinationDomain),
    allowance: [],
  },
  aleoWallet,
);

// Submit to Aleo network
await aleoWallet.signAndSend(forwardTx);
```

### Step 4: Receive on Destination

The destination chain automatically receives the transfer via Hyperlane message processing. No user action required.

## Commitment Format

Commitments use Keccak256 (matches Solidity):

```typescript
commitment = keccak256(
  abi.encode(
    secret, // bytes32 - user-generated secret
    recipient, // bytes32 - final recipient address
    amount, // uint256 - transfer amount
    destDomain, // uint32  - destination domain ID
    destRouter, // bytes32 - destination router address
    nonce, // uint256 - commitment nonce
  ),
);
```

**Total: 140 bytes packed**

## Message Encoding

### Deposit Message (Origin → Aleo): 141 bytes

```
[commitment(32)][amount(32)][nonce(4)][finalDest(4)][recipient(32)][destRouter(32)][padding(5)]
```

### Forward Message (Aleo → Destination): 109 bytes

```
[recipient(32)][amount(32)][commitment(32)][padding(13)]
```

## Security Considerations

### Secret Management

**Critical:** The 32-byte secret must be kept secure:

- Generate using cryptographically secure random
- Store encrypted locally
- Never log or transmit unencrypted
- User needs secret to forward deposit on Aleo

### Commitment File Storage

Example secure storage:

```typescript
import { createCommitmentFile } from './PrivateWarpUsageExample';

const commitmentData = createCommitmentFile(
  commitment,
  nonce,
  secret, // ENCRYPT THIS
  'ethereum',
  'polygon',
  recipient,
  amount,
  txHash,
);

// Store encrypted
await storeEncrypted(commitmentData, userPassword);
```

### Registration Requirement

Users MUST register on Aleo before depositing:

1. Call `register_user()` on Aleo with EVM address
2. Maps EVM address → Aleo address
3. Prevents unauthorized claim of deposits

### Expiry Protection

Deposits expire after ~30 days (518,400 blocks):

- Prevents locked funds
- Owner can refund to origin chain
- Grace period prevents race conditions

## Error Handling

### Common Errors

```typescript
// Router not enrolled
if ((await adapter.getRemoteRouter(domain)) === ethers.constants.HashZero) {
  throw new Error('Destination not enrolled');
}

// User not registered
const regInfo = await adapter.checkRegistration(domain, address);
if (!regInfo.isRegistered) {
  throw new Error('User must register on Aleo first');
}

// Commitment already used
if (await adapter.isCommitmentUsed(commitment)) {
  throw new Error('Commitment already claimed');
}

// Amount exceeds u128
if (amount > 2n ** 128n - 1n) {
  throw new Error('Amount too large for Aleo u128');
}
```

## Gas Estimation

Privacy routes have higher gas overhead due to Aleo routing:

```typescript
export const gasOverhead = (tokenType: TokenType): number => {
  switch (tokenType) {
    case TokenType.privateNative:
    case TokenType.privateCollateral:
    case TokenType.privateSynthetic:
      return 150_000; // Higher for privacy routing
    default:
      return 68_000;
  }
};
```

## Integration with Aleo SDK

The implementation requires Aleo SDK integration:

```typescript
// Required Aleo SDK functions (placeholders in current implementation)
- Keccak256::hash_to_field()
- Record encryption/decryption
- Transaction building
- Wallet integration (Leo Wallet, Puzzle)
```

## Testing

Recommended test scenarios:

1. **Registration:**
   - Register new user
   - Check registration status
   - Register same user twice (should be idempotent)

2. **Deposits:**
   - Native token deposit
   - ERC20 collateral deposit
   - Synthetic token deposit
   - Invalid amount (>u128)
   - Unregistered user

3. **Forwarding:**
   - Forward valid deposit
   - Forward with wrong secret
   - Forward expired deposit
   - Double-forward attempt

4. **Refunds:**
   - Refund expired deposit
   - Refund non-expired (should fail)
   - Refund by non-owner (should fail)

5. **Commitment:**
   - Compute commitment matches Solidity
   - Commitment uniqueness with nonce
   - Commitment replay protection

## Future Enhancements

1. **Aleo SDK Integration:**
   - Implement full Keccak256::hash_to_field
   - Add record parsing/encoding
   - Integrate Leo/Puzzle wallet SDKs

2. **Indexer Support:**
   - Query deposit records by owner
   - Track deposit status
   - Monitor forwarding history

3. **CLI Integration:**
   - Add `hyperlane warp deposit-private` command
   - Add `hyperlane warp forward` command
   - Add commitment file management

4. **UI Components:**
   - Deposit wizard with secret generation
   - Commitment file download
   - Forward transaction builder

5. **Multi-hop Privacy:**
   - Chain multiple Aleo hops
   - Cross-VM privacy (EVM → Cosmos → EVM via Aleo)

## Dependencies

```json
{
  "@hyperlane-xyz/core": "For contract ABIs and types",
  "@hyperlane-xyz/utils": "For address utilities and assertions",
  "@hyperlane-xyz/aleo-sdk": "For Aleo provider and transactions",
  "ethers": "For EVM interactions and encoding"
}
```

## Configuration Schema

Example warp route config:

```typescript
{
  ethereum: {
    type: TokenType.privateCollateral,
    token: '0xUSDC...',
    aleoPrivacyHub: '0x...', // bytes32 Aleo program address
    aleoDomain: 1001,
    mailbox: '0x...',
    owner: '0x...',
    // ... standard warp config
  },
  polygon: {
    type: TokenType.privateSynthetic,
    name: 'Private USDC',
    symbol: 'pUSDC',
    decimals: 6,
    aleoPrivacyHub: '0x...',
    aleoDomain: 1001,
    mailbox: '0x...',
    owner: '0x...',
  }
}
```

## Deployment Notes

1. Deploy HypPrivate contracts on all chains
2. Enroll remote routers on each chain
3. Deploy Aleo privacy hub program
4. Enroll all chain routers on Aleo hub
5. Configure ISMs and hooks
6. Test with small amounts first

## Contact & Support

For issues and questions:

- GitHub: hyperlane-xyz/hyperlane-monorepo
- Docs: docs.hyperlane.xyz
- Discord: discord.gg/hyperlane
