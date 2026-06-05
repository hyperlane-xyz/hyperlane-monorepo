import { Connection, PublicKey } from '@solana/web3.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { type Hex, bytesToHex, hexToBytes, keccak256 } from 'viem';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { isNullish } from '@hyperlane-xyz/utils';

import { Token } from '../token/Token.js';
import { TokenAmount } from '../token/TokenAmount.js';
import { SealevelHypNativeAdapter } from '../token/adapters/SealevelTokenAdapter.js';
import { SealevelHyperlaneTokenData } from '../token/adapters/serialization.js';
import { WarpCore } from '../warp/WarpCore.js';

import { FeeQuotingV2Client } from './client.js';
import {
  SealevelQuotedTransferProvider,
  computeSealevelScopedSalt,
} from './SealevelQuotedTransferProvider.js';
import type { SealevelQuoteV2Entry } from './types.js';

chai.use(chaiAsPromised);

const PAYER = new PublicKey('11111111111111111111111111111111');

describe('computeSealevelScopedSalt', () => {
  it('is deterministic for the same (payer, clientSalt)', () => {
    const salt = new Uint8Array(32).fill(0x42);
    const a = computeSealevelScopedSalt(PAYER, salt);
    const b = computeSealevelScopedSalt(PAYER, salt);
    expect([...a]).to.deep.equal([...b]);
  });

  it('returns 32 bytes', () => {
    const salt = new Uint8Array(32).fill(0x42);
    const scoped = computeSealevelScopedSalt(PAYER, salt);
    expect(scoped.length).to.equal(32);
  });

  it('differs when only the client salt changes', () => {
    const a = computeSealevelScopedSalt(PAYER, new Uint8Array(32).fill(0x42));
    const b = computeSealevelScopedSalt(PAYER, new Uint8Array(32).fill(0x43));
    expect([...a]).to.not.deep.equal([...b]);
  });

  it('differs when only the payer changes', () => {
    const salt = new Uint8Array(32).fill(0x42);
    const other = new PublicKey('SysvarRent111111111111111111111111111111111');
    const a = computeSealevelScopedSalt(PAYER, salt);
    const b = computeSealevelScopedSalt(other, salt);
    expect([...a]).to.not.deep.equal([...b]);
  });

  it('matches keccak256(payer.toBytes() || clientSalt)', () => {
    const salt = new Uint8Array(32).fill(0x42);
    const combined = new Uint8Array(32 + 32);
    combined.set(PAYER.toBytes(), 0);
    combined.set(salt, 32);
    const expected = hexToBytes(keccak256(combined));
    expect([...computeSealevelScopedSalt(PAYER, salt)]).to.deep.equal([
      ...expected,
    ]);
  });
});

// ============================================================
// Shared test fixtures + helpers (used by both describe blocks)
// ============================================================

const ORIGIN = 'solanamainnet';
const DEST = 'arbitrum';
const DEST_DOMAIN = 42161;
const ROUTER_PUBKEY = 'SysvarRent111111111111111111111111111111111';
const SENDER = '11111111111111111111111111111111';
const RECIPIENT: Hex = `0x${'aa'.repeat(20)}`;
const FEE_ACCOUNT = new PublicKey(
  'SysvarRent111111111111111111111111111111111',
);

interface MakeAdapterOpts {
  feeConfig: object | null;
  /** When set, makes `igpEnabled` evaluate true in the provider. */
  igp?: { innerIgpAccount: PublicKey; feeConfig: object };
  /** Per-destination gas budget map; only consulted on the IGP path. */
  destinationGas?: Map<number, bigint>;
}

function makeAdapter(opts: MakeAdapterOpts) {
  const adapter = sinon.createStubInstance(SealevelHypNativeAdapter);
  adapter.getTokenAccountData.resolves(
    new SealevelHyperlaneTokenData({
      mailbox: new Uint8Array(32),
      mailbox_process_authority: new Uint8Array(32),
      fee_config: opts.feeConfig,
      // Plain-object shape is enough: the provider only reads
      // `interchain_gas_paymaster?.program_id_pubkey`.
      interchain_gas_paymaster: opts.igp
        ? { program_id_pubkey: FEE_ACCOUNT }
        : undefined,
      destination_gas: opts.destinationGas,
    }),
  );
  adapter.getRouterAddress.resolves(Buffer.from(new Uint8Array(32).fill(0xaa)));
  Object.defineProperty(adapter, 'innerIgpFeeState', {
    value: { get: sinon.stub().resolves(opts.igp) },
  });
  return adapter;
}

function makeWarpCore(adapter: SealevelHypNativeAdapter) {
  const token = sinon.createStubInstance(Token);
  Object.defineProperty(token, 'chainName', { value: ORIGIN });
  Object.defineProperty(token, 'addressOrDenom', { value: ROUTER_PUBKEY });
  token.getHypAdapter.returns(adapter);

  const originTokenAmount = sinon.createStubInstance(TokenAmount);
  Object.defineProperty(originTokenAmount, 'token', { value: token });
  // configurable+writable so per-test helpers can override the amount.
  Object.defineProperty(originTokenAmount, 'amount', {
    value: 1000n,
    configurable: true,
    writable: true,
  });

  const warpCore = sinon.createStubInstance(WarpCore);
  Object.defineProperty(warpCore, 'multiProvider', {
    value: {
      getDomainId: () => DEST_DOMAIN,
      getChainName: () => DEST,
      // Needed by `getQuotedTransferFee` for `Token.FromChainMetadataNativeToken`.
      // The `buildQuotedTransferTxs` tests don't reach this call.
      getChainMetadata: () => ({
        protocol: ProtocolType.Sealevel,
        name: ORIGIN,
        nativeToken: { symbol: 'SOL', name: 'Solana', decimals: 9 },
      }),
    },
  });
  warpCore.isCrossCollateralTransfer.returns(false);

  return { warpCore, originTokenAmount };
}

function makeWarpEntry(
  protocol: ProtocolType.Sealevel | ProtocolType.Ethereum,
): SealevelQuoteV2Entry {
  // The protocol field is intentionally widened here so tests can construct
  // a wrong-protocol entry that exercises the provider's narrowing
  // assertion. Real server responses always carry ProtocolType.Sealevel.
  return {
    protocol: protocol as ProtocolType.Sealevel,
    quoter: FEE_ACCOUNT.toBase58(),
    issuedAt: 1700000000,
    expiry: 1700003600,
    details: {
      domainId: DEST_DOMAIN,
      signedQuote: {
        context: `0x${'11'.repeat(44)}`,
        data: `0x${'22'.repeat(8)}`,
        issuedAt: `0x${'33'.repeat(6)}`,
        expiry: `0x${'44'.repeat(6)}`,
        clientSalt: `0x${'55'.repeat(32)}`,
        signature: `0x${'66'.repeat(65)}`,
      },
    },
  };
}

function makeClient(
  warpEntry: SealevelQuoteV2Entry,
  igpEntry?: SealevelQuoteV2Entry,
) {
  const client = sinon.createStubInstance(FeeQuotingV2Client);
  client.getWarpQuote.resolves(warpEntry);
  if (igpEntry) client.getIgpQuote.resolves(igpEntry);
  return client;
}

function makeProvider(client: FeeQuotingV2Client) {
  return new SealevelQuotedTransferProvider({
    feeQuotingClient: client,
    connection: sinon.createStubInstance(Connection),
  });
}

/**
 * Borsh `FeeDataStrategy` for warp fee tests:
 *   1-byte kind + u64 LE maxFee + u64 LE halfAmount = 17 bytes.
 * Matches the on-chain `encodeFeeDataStrategy` format.
 */
function encodeFeeStrategy(
  kind: number,
  maxFee: bigint,
  halfAmount: bigint,
): Hex {
  const buf = new Uint8Array(17);
  const dv = new DataView(buf.buffer);
  dv.setUint8(0, kind);
  dv.setBigUint64(1, maxFee, true);
  dv.setBigUint64(9, halfAmount, true);
  return bytesToHex(buf);
}

/**
 * IgpQuoteData for IGP tests:
 *   u128 LE token_exchange_rate + u128 LE gas_price + u8 token_decimals
 *   = 33 bytes. Matches the on-chain `IgpQuoteData` wire layout.
 */
function encodeIgpQuoteData(
  tokenExchangeRate: bigint,
  gasPrice: bigint,
  tokenDecimals: number,
): Hex {
  const buf = new Uint8Array(33);
  const dv = new DataView(buf.buffer);
  const mask64 = 0xffffffffffffffffn;
  dv.setBigUint64(0, tokenExchangeRate & mask64, true);
  dv.setBigUint64(8, tokenExchangeRate >> 64n, true);
  dv.setBigUint64(16, gasPrice & mask64, true);
  dv.setBigUint64(24, gasPrice >> 64n, true);
  dv.setUint8(32, tokenDecimals);
  return bytesToHex(buf);
}

describe('SealevelQuotedTransferProvider.buildQuotedTransferTxs', () => {
  afterEach(() => sinon.restore());

  it('throws when origin token has no fee_config', async () => {
    const { warpCore, originTokenAmount } = makeWarpCore(
      makeAdapter({ feeConfig: null }),
    );
    const provider = makeProvider(
      makeClient(makeWarpEntry(ProtocolType.Sealevel)),
    );

    await expect(
      provider.buildQuotedTransferTxs({
        warpCore,
        originTokenAmount,
        destination: DEST,
        sender: SENDER,
        recipient: RECIPIENT,
      }),
    ).to.be.rejectedWith(/fee_config/);
  });

  it('throws when warp quote returns a non-Sealevel protocol', async () => {
    const { warpCore, originTokenAmount } = makeWarpCore(
      makeAdapter({ feeConfig: { feeProgram: 'x' } }),
    );
    const provider = makeProvider(
      makeClient(makeWarpEntry(ProtocolType.Ethereum)),
    );

    await expect(
      provider.buildQuotedTransferTxs({
        warpCore,
        originTokenAmount,
        destination: DEST,
        sender: SENDER,
        recipient: RECIPIENT,
      }),
    ).to.be.rejectedWith(/Sealevel warp quote/);
  });

  // Orchestration paths that require mocking `Connection.simulateTransaction`
  // (for `buildSubmitFeeQuoteIx`) are exercised end-to-end by the SVM SDK
  // e2e tests (`warp-transfer-remote-with-fees.e2e-test.ts`) and by the
  // upstream adapter integration branch. They are intentionally not unit-
  // tested here — paths covered: CC vs non-CC adapter dispatch, IGP enabled
  // vs disabled prelude length, warp/IGP mode-mismatch assertion, 76B CC
  // context `effectiveTargetRouter` extraction.
});

describe('SealevelQuotedTransferProvider.getQuotedTransferFee', () => {
  function makeQuoteEntryWithStrategy(
    kind: number,
    maxFee: bigint,
    halfAmount: bigint,
  ): SealevelQuoteV2Entry {
    const entry = makeWarpEntry(ProtocolType.Sealevel);
    entry.details.signedQuote.data = encodeFeeStrategy(
      kind,
      maxFee,
      halfAmount,
    );
    return entry;
  }

  function makeIgpEntry(data: Hex): SealevelQuoteV2Entry {
    const entry = makeWarpEntry(ProtocolType.Sealevel);
    entry.details.signedQuote.data = data;
    return entry;
  }

  function callWithAmount(
    warpEntry: SealevelQuoteV2Entry,
    transferAmount: bigint,
    igpOpts?: {
      entry: SealevelQuoteV2Entry;
      destinationGas?: bigint;
    },
  ) {
    const { warpCore, originTokenAmount } = makeWarpCore(
      makeAdapter({
        feeConfig: { feeProgram: 'x' },
        igp: igpOpts
          ? { innerIgpAccount: FEE_ACCOUNT, feeConfig: {} }
          : undefined,
        destinationGas:
          igpOpts && !isNullish(igpOpts.destinationGas)
            ? new Map([[DEST_DOMAIN, igpOpts.destinationGas]])
            : undefined,
      }),
    );
    Object.defineProperty(originTokenAmount, 'amount', {
      value: transferAmount,
      configurable: true,
      writable: true,
    });
    const provider = makeProvider(makeClient(warpEntry, igpOpts?.entry));
    return provider.getQuotedTransferFee({
      warpCore,
      originTokenAmount,
      destination: DEST,
      sender: SENDER,
      recipient: RECIPIENT,
    });
  }

  afterEach(() => sinon.restore());

  // ====== Warp fee path (Linear FeeDataStrategy) ======

  it('returns undefined tokenFeeQuote when offchain server signs maxFee=0', async () => {
    const warp = makeQuoteEntryWithStrategy(0, 0n, 1n);
    const result = await callWithAmount(warp, 1000n);
    expect(result.tokenFeeQuote).to.equal(undefined);
    expect(result.igpQuote.amount).to.equal(0n); // no IGP entry → native zero
  });

  it('applies the Linear formula: fee = amount * maxFee / (2 * halfAmount)', async () => {
    // amount=1000, maxFee=100, halfAmount=500 → 1000*100/(2*500) = 100
    const warp = makeQuoteEntryWithStrategy(0, 100n, 500n);
    const result = await callWithAmount(warp, 1000n);
    expect(result.tokenFeeQuote?.amount).to.equal(100n);
  });

  it('caps the fee at maxFee when the raw curve exceeds it', async () => {
    // amount=10000, maxFee=100, halfAmount=10 → raw=50000, capped to 100
    const warp = makeQuoteEntryWithStrategy(0, 100n, 10n);
    const result = await callWithAmount(warp, 10000n);
    expect(result.tokenFeeQuote?.amount).to.equal(100n);
  });

  it('returns no tokenFeeQuote when halfAmount=0 (div-by-zero guard)', async () => {
    const warp = makeQuoteEntryWithStrategy(0, 100n, 0n);
    const result = await callWithAmount(warp, 1000n);
    expect(result.tokenFeeQuote).to.equal(undefined);
  });

  it('rejects non-Linear strategy variants', async () => {
    // kind=1 is Regressive; only Linear (kind=0) is supported.
    const warp = makeQuoteEntryWithStrategy(1, 100n, 500n);
    await expect(callWithAmount(warp, 1000n)).to.be.rejectedWith(/only Linear/);
  });

  // ====== IGP path (IgpQuoteData + compute_gas_fee) ======

  it('returns 0 igpQuote when server signs gas_price=0', async () => {
    const warp = makeQuoteEntryWithStrategy(0, 0n, 1n);
    // token_exchange_rate=10^19 (=1.0), gas_price=0, token_decimals=9
    const igp = makeIgpEntry(encodeIgpQuoteData(10n ** 19n, 0n, 9));
    const result = await callWithAmount(warp, 1000n, {
      entry: igp,
      destinationGas: 1000n,
    });
    expect(result.igpQuote.amount).to.equal(0n);
  });

  it('applies compute_gas_fee: gasAmount × gas_price × TER / 10^19 with same-decimals', async () => {
    const warp = makeQuoteEntryWithStrategy(0, 0n, 1n);
    // TER=10^19 (=1.0), gas_price=1, token_decimals=9 (no conversion), gasAmount=1000
    // Expected: 1000 * 1 * 10^19 / 10^19 = 1000 lamports.
    const igp = makeIgpEntry(encodeIgpQuoteData(10n ** 19n, 1n, 9));
    const result = await callWithAmount(warp, 1000n, {
      entry: igp,
      destinationGas: 1000n,
    });
    expect(result.igpQuote.amount).to.equal(1000n);
  });

  it('scales by TER when ≠ 10^19 (1.0)', async () => {
    // TER=2×10^19 (=2.0), gas_price=3, token_decimals=9, gasAmount=100
    // Expected: 100 * 3 * 2×10^19 / 10^19 = 600 lamports.
    // A regression that drops the TER factor would compute 100*3 = 300 instead.
    const warp = makeQuoteEntryWithStrategy(0, 0n, 1n);
    const igp = makeIgpEntry(encodeIgpQuoteData(2n * 10n ** 19n, 3n, 9));
    const result = await callWithAmount(warp, 1000n, {
      entry: igp,
      destinationGas: 100n,
    });
    expect(result.igpQuote.amount).to.equal(600n);
  });

  it('applies convert_decimals when remote token_decimals < SOL_DECIMALS', async () => {
    // TER=10^19, gas_price=1000, token_decimals=6 (< 9), gasAmount=1
    //   destCost   = 1 * 1000          = 1000
    //   originCost = 1000 * 10^19/10^19 = 1000
    //   convert    = 1000 * 10^(9-6)   = 1_000_000 lamports
    // A regression that drops the decimal-conversion arm would return 1000.
    const warp = makeQuoteEntryWithStrategy(0, 0n, 1n);
    const igp = makeIgpEntry(encodeIgpQuoteData(10n ** 19n, 1000n, 6));
    const result = await callWithAmount(warp, 1000n, {
      entry: igp,
      destinationGas: 1n,
    });
    expect(result.igpQuote.amount).to.equal(1_000_000n);
  });

  it('applies convert_decimals when remote token_decimals > SOL_DECIMALS', async () => {
    // TER=10^19, gas_price=1, token_decimals=18 (> 9, like ETH), gasAmount=10^12
    //   destCost   = 10^12 * 1            = 10^12
    //   originCost = 10^12 * 10^19/10^19  = 10^12
    //   convert    = 10^12 / 10^(18-9)    = 1000 lamports
    const warp = makeQuoteEntryWithStrategy(0, 0n, 1n);
    const igp = makeIgpEntry(encodeIgpQuoteData(10n ** 19n, 1n, 18));
    const result = await callWithAmount(warp, 1000n, {
      entry: igp,
      destinationGas: 10n ** 12n,
    });
    expect(result.igpQuote.amount).to.equal(1000n);
  });

  it('rejects IGP quotes with wrong data length (17 bytes where 33 expected)', async () => {
    // Common regression pattern: someone passes a warp FeeDataStrategy
    // (17 bytes) where IgpQuoteData (33 bytes) is expected.
    const warp = makeQuoteEntryWithStrategy(0, 0n, 1n);
    const igp = makeIgpEntry(encodeFeeStrategy(0, 0n, 1n)); // 17 bytes
    await expect(
      callWithAmount(warp, 1000n, { entry: igp, destinationGas: 1000n }),
    ).to.be.rejectedWith(/IgpQuoteData must be 33 bytes/);
  });

  it('throws when IGP is configured but destination_gas is unset for the domain', async () => {
    // On-chain `dispatch_with_gas` unwraps destination_gas via
    // `ok_or(InvalidArgument)`, so the submit path would fail at
    // `transfer_remote`. Display must surface that instead of silently
    // reporting 0.
    const warp = makeQuoteEntryWithStrategy(0, 0n, 1n);
    const igp = makeIgpEntry(encodeIgpQuoteData(10n ** 19n, 1n, 9));
    await expect(
      callWithAmount(warp, 1000n, { entry: igp /* no destinationGas */ }),
    ).to.be.rejectedWith(/no destination_gas configured/);
  });
});
