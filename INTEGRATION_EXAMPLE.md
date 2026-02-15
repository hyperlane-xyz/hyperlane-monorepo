# Privacy Warp Routes - Integration Example

End-to-end example of integrating privacy warp routes into your application.

## Full Integration Flow

```typescript
import { ethers } from 'ethers';
import { ChainName, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import {
  PrivateWarpOriginAdapter,
  AleoPrivacyHubAdapter,
  AleoWalletAdapter
} from '@hyperlane-xyz/sdk';

// ============ Setup ============

const provider = new ethers.providers.JsonRpcProvider('https://eth-mainnet.g.alchemy.com/v2/...');
const signer = new ethers.Wallet('0x...', provider);
const multiProvider = new MultiProtocolProvider({ /* config */ });

// ============ Step 0: Check Registration (One-Time) ============

const originAdapter = new PrivateWarpOriginAdapter({
  chainName: ChainName.ethereum,
  multiProvider,
  routerAddress: '0xYourPrivateRouter',
  aleoPrivacyHub: 'privacy_hub.aleo',
  aleoDomain: 9999999
});

const isRegistered = await originAdapter.isRegistered(signer.address);

if (!isRegistered) {
  console.log('Registration required. Please register your Aleo address:');
  console.log('Run: hyperlane privacy register --chain ethereum');
  process.exit(1);
}

// ============ Step 1: Deposit on Origin Chain ============

const depositResult = await originAdapter.depositPrivate({
  secret: ethers.utils.randomBytes(32), // Auto-generate secret
  destination: ChainName.polygon,
  recipient: '0xRecipientAddress',
  amount: ethers.utils.parseUnits('1000', 6), // 1000 USDC
  signer
});

console.log('✅ Deposit successful');
console.log(`Transaction: ${depositResult.txHash}`);
console.log(`Commitment: ${depositResult.commitment}`);
console.log(`Commitment file: ${depositResult.commitmentFilePath}`);

// Save commitment data
const commitmentData = {
  commitment: depositResult.commitment,
  secret: ethers.utils.hexlify(depositResult.secret),
  nonce: depositResult.nonce,
  recipient: '0xRecipientAddress',
  amount: '1000000000', // 1000 USDC (6 decimals)
  destination: 'polygon',
  origin: 'ethereum',
  timestamp: Date.now()
};

await fs.writeFile('commitment.json', JSON.stringify(commitmentData, null, 2));

// ============ Step 2: Wait for Deposit on Aleo ============

const aleoAdapter = new AleoPrivacyHubAdapter({
  privacyHubProgram: 'privacy_hub.aleo',
  aleoProvider: /* Aleo RPC */,
  aleoWallet: /* Leo Wallet instance */
});

console.log('⏳ Waiting for deposit to arrive on Aleo...');

await aleoAdapter.waitForDeposit(depositResult.commitment, {
  timeout: 300000, // 5 minutes
  pollInterval: 5000 // Check every 5 seconds
});

console.log('✅ Deposit received on Aleo (private record created)');

// ============ Step 3: Forward to Destination (User Controls Timing) ============

// Option A: Forward immediately
await aleoAdapter.forward({
  commitment: commitmentData.commitment,
  secret: commitmentData.secret,
  aleoWallet: /* wallet instance */
});

// Option B: Forward with delay (better privacy)
setTimeout(async () => {
  await aleoAdapter.forward({
    commitment: commitmentData.commitment,
    secret: commitmentData.secret,
    aleoWallet: /* wallet instance */
  });
}, 3600000); // Wait 1 hour

console.log('✅ Forward submitted on Aleo');

// ============ Step 4: Track Delivery ============

console.log('⏳ Waiting for delivery to destination...');

// Monitor destination chain for receipt
const destProvider = multiProvider.getProvider(ChainName.polygon);
const destRouter = new ethers.Contract(
  '0xDestinationRouter',
  HypPrivateABI,
  destProvider
);

// Listen for ReceivedFromPrivacyHub event
destRouter.on('ReceivedFromPrivacyHub', (commitment, recipient, amount) => {
  if (commitment === commitmentData.commitment) {
    console.log('✅ Transfer complete!');
    console.log(`Recipient: ${recipient}`);
    console.log(`Amount: ${ethers.utils.formatUnits(amount, 6)} USDC`);
  }
});

// ============ Alternative: Refund if Expired ============

// If transfer expires (30 days), refund to origin
const isExpired = await aleoAdapter.isExpired(commitmentData.commitment);

if (isExpired) {
  await aleoAdapter.refundExpired({
    commitment: commitmentData.commitment,
    refundRecipient: signer.address, // Or any address
    aleoWallet: /* wallet instance */
  });

  console.log('✅ Refund initiated (funds returning to origin)');
}
```

## React Integration

```typescript
import { usePrivateWarpTransfer } from '@hyperlane-xyz/widgets';

function PrivateTransferWidget() {
  const {
    deposit,
    forward,
    checkRegistration,
    register,
    isLoading,
    error
  } = usePrivateWarpTransfer({
    origin: 'ethereum',
    destination: 'polygon',
    token: 'USDC'
  });

  return (
    <div>
      <h2>Private Token Transfer</h2>

      {/* Step 1: Check registration */}
      <button onClick={checkRegistration}>
        Check Registration Status
      </button>

      {/* Step 2: Deposit */}
      <button onClick={() => deposit({
        amount: '1000',
        recipient: '0xRecipient...'
      })}>
        Deposit Tokens
      </button>

      {/* Step 3: Forward */}
      <button onClick={forward} disabled={!depositComplete}>
        Forward to Destination
      </button>

      {/* Status */}
      {isLoading && <p>Processing...</p>}
      {error && <p>Error: {error.message}</p>}
    </div>
  );
}
```

## Security Best Practices

### 1. Secret Generation

```typescript
// ✅ GOOD: Use cryptographically secure randomness
const secret = ethers.utils.randomBytes(32);

// ❌ BAD: Predictable secrets
const secret = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('my password'));
```

### 2. Commitment File Storage

```typescript
// ✅ GOOD: Encrypt before storing
import { encrypt } from 'some-encryption-library';

const encryptedCommitment = encrypt(
  JSON.stringify(commitmentData),
  userPassword,
);

await fs.writeFile('commitment.enc', encryptedCommitment);

// ❌ BAD: Store plaintext
await fs.writeFile('commitment.json', JSON.stringify(commitmentData));
```

### 3. Timing Privacy

```typescript
// ✅ GOOD: Random delay
const delay = Math.random() * 3600000; // 0-1 hour
setTimeout(forward, delay);

// ❌ BAD: Immediate forward
await forward(); // Links deposit -> forward by timing
```

### 4. Amount Obfuscation

```typescript
// ✅ GOOD: Round to common denominations
const amount = 1000; // Even number

// ✅ BETTER: Use common amounts
const commonAmounts = [100, 500, 1000, 5000, 10000];
const amount = commonAmounts[Math.floor(Math.random() * commonAmounts.length)];

// ❌ BAD: Unique amounts
const amount = 1234.56789; // Easy to correlate
```

## Error Handling

```typescript
try {
  await originAdapter.depositPrivate({
    secret,
    destination,
    recipient,
    amount,
    signer,
  });
} catch (error) {
  if (error.message.includes('not registered')) {
    console.log('Please register first: hyperlane privacy register');
  } else if (error.message.includes('router not enrolled')) {
    console.log('Destination router not enrolled. Contact route operator.');
  } else if (error.message.includes('amount exceeds u128')) {
    console.log('Amount too large. Maximum: 2^128 - 1');
  } else if (error.message.includes('insufficient collateral')) {
    console.log('Destination lacks collateral. Wait for rebalancing.');
  } else {
    console.error('Unexpected error:', error);
  }
}
```

## Monitoring Transfers

```typescript
async function monitorTransfer(commitment: string) {
  const aleoAdapter = new AleoPrivacyHubAdapter(/* ... */);

  // Check deposit status
  const depositStatus = await aleoAdapter.getDepositStatus(commitment);
  console.log(`Deposit status: ${depositStatus.state}`);

  if (depositStatus.state === 'pending') {
    console.log('Waiting for deposit on Aleo...');
  } else if (depositStatus.state === 'forwarded') {
    console.log('Already forwarded to destination');
  } else if (depositStatus.state === 'expired') {
    console.log('Transfer expired - refund available');
  }

  // Check if used
  const isUsed = await aleoAdapter.isCommitmentUsed(commitment);
  if (isUsed) {
    console.log('⚠️ Commitment already used (forwarded or refunded)');
  }

  // Check expiry
  const blocksUntilExpiry = await aleoAdapter.getBlocksUntilExpiry(commitment);
  console.log(
    `Expires in ${blocksUntilExpiry} blocks (~${blocksUntilExpiry * 5}s)`,
  );
}
```

## Privacy Analysis

```typescript
async function analyzePrivacy(commitment: string) {
  const aleoAdapter = new AleoPrivacyHubAdapter(/* ... */);

  // Get current anonymity set
  const anonymitySet = await aleoAdapter.getAnonymitySetSize();

  let privacyRating: string;
  if (anonymitySet < 3) {
    privacyRating = 'WEAK - Consider waiting for more concurrent transfers';
  } else if (anonymitySet < 5) {
    privacyRating = 'MODERATE - Some privacy, but linkability possible';
  } else if (anonymitySet < 10) {
    privacyRating = 'GOOD - Strong privacy with current volume';
  } else {
    privacyRating = 'STRONG - Excellent privacy guarantees';
  }

  console.log(`Anonymity Set: ${anonymitySet} concurrent transfers`);
  console.log(`Privacy Rating: ${privacyRating}`);

  return {
    anonymitySet,
    privacyRating,
    recommendForward: anonymitySet >= 5,
  };
}
```

## Testing

```typescript
import { expect } from 'chai';

describe('Privacy Warp Routes Integration', () => {
  it('should complete full transfer flow', async () => {
    // Register (one-time)
    await aleoAdapter.register({
      originChain: 1,
      evmAddress: signer.address,
      aleoWallet,
    });

    // Deposit
    const { commitment, secret } = await originAdapter.depositPrivate({
      secret: ethers.utils.randomBytes(32),
      destination: 'polygon',
      recipient: '0xBob',
      amount: ethers.utils.parseUnits('100', 6),
      signer,
    });

    // Wait for Aleo
    await aleoAdapter.waitForDeposit(commitment);

    // Forward
    await aleoAdapter.forward({
      commitment,
      secret: ethers.utils.hexlify(secret),
      aleoWallet,
    });

    // Verify delivery
    // (Check destination chain for ReceivedFromPrivacyHub event)
  });

  it('should refund expired transfer', async () => {
    // ... deposit and wait for expiry ...

    await aleoAdapter.refundExpired({
      commitment,
      refundRecipient: signer.address,
      aleoWallet,
    });

    // Verify refund on origin chain
  });
});
```

## Production Considerations

### 1. Relayer Configuration

Ensure relayers are configured to process messages from/to Aleo:

- Monitor Ethereum → Aleo routes
- Monitor Aleo → Polygon routes
- Handle ISM verification (multisig signatures)

### 2. Collateral Management

For collateral-type routes, monitor balances:

```typescript
setInterval(async () => {
  const balance = await collateralRouter.collateralBalance();
  const threshold = ethers.utils.parseUnits('10000', 6); // 10k USDC

  if (balance.lt(threshold)) {
    console.warn(
      `⚠️ Low collateral on ${chain}: ${ethers.utils.formatUnits(balance, 6)}`,
    );
    // Trigger rebalancing
  }
}, 300000); // Check every 5 minutes
```

### 3. Privacy Monitoring

Track anonymity set size and warn users:

```typescript
const privacy = await analyzePrivacy(commitment);

if (privacy.anonymitySet < 3) {
  showWarning(
    'LOW PRIVACY: Only ' + privacy.anonymitySet + ' concurrent transfers',
  );
}
```

### 4. Error Recovery

Implement robust error handling:

```typescript
// Retry logic for failed forwards
async function forwardWithRetry(params, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await aleoAdapter.forward(params);
    } catch (error) {
      if (error.message.includes('expired')) {
        throw error; // Don't retry expired
      }
      console.log(`Retry ${i + 1}/${maxRetries}...`);
      await sleep(5000);
    }
  }
  throw new Error('Forward failed after retries');
}
```

## Links

- [Implementation Plan](./PRIVACY_WARP_ROUTES_IMPLEMENTATION_PLAN.md)
- [Quickstart Guide](./PRIVACY_WARP_ROUTES_QUICKSTART.md)
- [CLI Guide](./typescript/cli/src/commands/PRIVACY_CLI_GUIDE.md)
- [SDK Documentation](./typescript/sdk/PRIVACY_SDK_IMPLEMENTATION.md)
