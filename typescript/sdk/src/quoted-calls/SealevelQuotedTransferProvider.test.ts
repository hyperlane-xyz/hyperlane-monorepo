import { Connection, PublicKey } from '@solana/web3.js';
import { BinaryReader, BinaryWriter } from 'borsh';
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
const ORIGIN_DOMAIN = 1399811149;
const DEST = 'arbitrum';
const DEST_DOMAIN = 42161;
const ROUTER_PUBKEY = 'SysvarRent111111111111111111111111111111111';
const SENDER = '11111111111111111111111111111111';
const RECIPIENT: Hex = `0x${'aa'.repeat(20)}`;
const FEE_ACCOUNT = new PublicKey(
  'SysvarRent111111111111111111111111111111111',
);

// borsh@0.7 decodes u64 map values as bn.js `BN`, which the `bigint` types on
// `destination_gas` / `gasOverheads` hide. Tests use both shapes.
type U64 = bigint | ReturnType<BinaryReader['readU64']>;

/**
 * Mints a genuine borsh-decoded u64 (bn.js `BN`) — the real runtime type
 * `destination_gas` / `gasOverheads` carry — so IGP tests exercise the same
 * value a live account decode produces, not a hand-built `bigint`.
 */
function borshU64(value: number): ReturnType<BinaryReader['readU64']> {
  const writer = new BinaryWriter();
  writer.writeU64(value);
  return new BinaryReader(Buffer.from(writer.toArray())).readU64();
}

interface MakeAdapterOpts {
  feeConfig: object | null;
  /**
   * IGP account state. `feeConfig` set → new-flow (`igpEnabled` true); omit it
   * to simulate a legacy (non-upgraded) IGP route.
   */
  igp?: {
    innerIgpAccount: PublicKey;
    feeConfig?: object;
    /** OverheadIgp per-destination overhead, added before pricing. */
    gasOverheads?: Map<number, U64>;
  };
  /** Per-destination gas budget map; only consulted on the IGP path. */
  destinationGas?: Map<number, U64>;
  /** Stubs `quoteLegacyIgpGasPayment` for the legacy (no-fee_config) path. */
  legacyIgpGasPayment?: bigint;
  /** Overrides `innerIgpFeeState.get` so tests can assert whether it fires. */
  igpGet?: sinon.SinonStub;
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
  if (!isNullish(opts.legacyIgpGasPayment)) {
    adapter.quoteLegacyIgpGasPayment.resolves(opts.legacyIgpGasPayment);
  }
  Object.defineProperty(adapter, 'innerIgpFeeState', {
    value: { get: opts.igpGet ?? sinon.stub().resolves(opts.igp) },
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
      getDomainId: (chain: string) =>
        chain === ORIGIN ? ORIGIN_DOMAIN : DEST_DOMAIN,
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
  contextByteLen = 44,
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
        context: `0x${'11'.repeat(contextByteLen)}`,
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

  it('throws when the signed-quote context is neither 44B nor 76B', async () => {
    const { warpCore, originTokenAmount } = makeWarpCore(
      makeAdapter({ feeConfig: { feeProgram: 'x' } }),
    );
    const provider = makeProvider(
      makeClient(makeWarpEntry(ProtocolType.Sealevel, 30)),
    );

    await expect(
      provider.buildQuotedTransferTxs({
        warpCore,
        originTokenAmount,
        destination: DEST,
        sender: SENDER,
        recipient: RECIPIENT,
      }),
    ).to.be.rejectedWith(/Unexpected signed-quote context length/);
  });

  it('does not load IGP state for a same-domain (local) destination', async () => {
    const igpGet = sinon.stub().resolves(undefined);
    const { warpCore, originTokenAmount } = makeWarpCore(
      makeAdapter({ feeConfig: { feeProgram: 'x' }, igpGet }),
    );
    const provider = makeProvider(
      makeClient(makeWarpEntry(ProtocolType.Sealevel)),
    );

    // destination === origin chain → local transfer. The build continues past
    // the IGP gate and fails later at ix simulation (Connection is stubbed),
    // but the IGP-state RPC must never fire for a local transfer.
    await provider
      .buildQuotedTransferTxs({
        warpCore,
        originTokenAmount,
        destination: ORIGIN,
        sender: SENDER,
        recipient: RECIPIENT,
      })
      .catch(() => undefined);

    expect(igpGet.called).to.be.false;
  });

  it('loads IGP state for a remote destination', async () => {
    const igpGet = sinon.stub().resolves(undefined);
    const { warpCore, originTokenAmount } = makeWarpCore(
      makeAdapter({ feeConfig: { feeProgram: 'x' }, igpGet }),
    );
    const provider = makeProvider(
      makeClient(makeWarpEntry(ProtocolType.Sealevel)),
    );

    await provider
      .buildQuotedTransferTxs({
        warpCore,
        originTokenAmount,
        destination: DEST,
        sender: SENDER,
        recipient: RECIPIENT,
      })
      .catch(() => undefined);

    expect(igpGet.called).to.be.true;
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
      destinationGas?: U64;
      gasOverheads?: U64;
    },
  ) {
    const { warpCore, originTokenAmount } = makeWarpCore(
      makeAdapter({
        feeConfig: { feeProgram: 'x' },
        igp: igpOpts
          ? {
              innerIgpAccount: FEE_ACCOUNT,
              feeConfig: {},
              gasOverheads: isNullish(igpOpts.gasOverheads)
                ? undefined
                : new Map([[DEST_DOMAIN, igpOpts.gasOverheads]]),
            }
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

  it('normalizes the borsh-decoded BN destination_gas before pricing', async () => {
    // Regression: borsh@0.7 decodes destination_gas u64 map values as bn.js BN.
    // Without a BigInt normalization, BN(1000) + bigint overhead concatenates
    // to "1000200" and computeIgpGasFee's multiply throws — so live SVM
    // preflight crashes. gasOverheads is normalized upstream in
    // loadInnerIgpFeeState, so it arrives here as a real bigint (still
    // exercising the overhead-add path).
    // TER=10^19 (1.0), gas_price=1, decimals=9 → fee = (1000 + 200) * 1 = 1200.
    const warp = makeQuoteEntryWithStrategy(0, 0n, 1n);
    const igp = makeIgpEntry(encodeIgpQuoteData(10n ** 19n, 1n, 9));
    const result = await callWithAmount(warp, 1000n, {
      entry: igp,
      destinationGas: borshU64(1000),
      gasOverheads: 200n,
    });
    expect(result.igpQuote.amount).to.equal(1200n);
  });

  it('skips IGP for a same-domain (local) transfer instead of asserting on destination_gas', async () => {
    // Same-domain (destination === origin) pays no IGP on-chain. Even with an
    // IGP quote available and destination_gas unset, it must return 0 rather
    // than asserting — mirrors buildQuotedTransferTxs's local gate.
    const adapter = makeAdapter({
      feeConfig: { feeProgram: 'x' },
      igp: { innerIgpAccount: FEE_ACCOUNT, feeConfig: {} },
      // destination_gas intentionally unset
    });
    const { warpCore, originTokenAmount } = makeWarpCore(adapter);
    const provider = makeProvider(
      makeClient(
        makeQuoteEntryWithStrategy(0, 0n, 1n),
        makeIgpEntry(encodeIgpQuoteData(10n ** 19n, 1n, 9)),
      ),
    );

    const result = await provider.getQuotedTransferFee({
      warpCore,
      originTokenAmount,
      destination: ORIGIN, // same as origin → local transfer
      sender: SENDER,
      recipient: RECIPIENT,
    });

    expect(result.igpQuote.amount).to.equal(0n);
  });

  it('displays the legacy on-chain IGP quote when the route has no offchain fee_config', async () => {
    // Legacy IGP (not upgraded to offchain quoting): igpState present but no
    // feeConfig → no signed IGP quote, so igpEnabled is false. The submit path
    // falls back to on-chain quoteGasPayment, so display must mirror it rather
    // than reporting 0.
    const adapter = makeAdapter({
      feeConfig: { feeProgram: 'x' },
      igp: { innerIgpAccount: FEE_ACCOUNT }, // no feeConfig → not upgraded
      destinationGas: new Map([[DEST_DOMAIN, 1000n]]),
      legacyIgpGasPayment: 4242n,
    });
    const { warpCore, originTokenAmount } = makeWarpCore(adapter);
    const provider = makeProvider(
      makeClient(makeQuoteEntryWithStrategy(0, 0n, 1n)),
    );

    const result = await provider.getQuotedTransferFee({
      warpCore,
      originTokenAmount,
      destination: DEST,
      sender: SENDER,
      recipient: RECIPIENT,
    });

    expect(result.igpQuote.amount).to.equal(4242n);
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

  it('rejects an IGP fee that overflows the on-chain u64', async () => {
    // gasAmount=2^63, gas_price=4 → destCost=2^65 > u64::MAX; the on-chain
    // quote_gas_payment as_u64() would panic, so preflight must reject rather
    // than display a fee the transfer can never pay.
    const warp = makeQuoteEntryWithStrategy(0, 0n, 1n);
    const igp = makeIgpEntry(encodeIgpQuoteData(10n ** 19n, 4n, 9));
    await expect(
      callWithAmount(warp, 1000n, { entry: igp, destinationGas: 2n ** 63n }),
    ).to.be.rejectedWith(/exceeds u64/);
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

  it('throws when a legacy IGP route has no destination_gas for the domain', async () => {
    // Legacy IGP (no offchain fee_config) still needs destination_gas: the
    // submit path's on-chain quoteGasPayment unwraps it. Without the fail-fast
    // this fell through to a 0 display while the transfer would revert at
    // submit — the same gap the new-flow guard above closes.
    const adapter = makeAdapter({
      feeConfig: { feeProgram: 'x' },
      igp: { innerIgpAccount: FEE_ACCOUNT }, // no feeConfig → legacy
      // destination_gas intentionally unset
    });
    const { warpCore, originTokenAmount } = makeWarpCore(adapter);
    const provider = makeProvider(
      makeClient(makeQuoteEntryWithStrategy(0, 0n, 1n)),
    );

    await expect(
      provider.getQuotedTransferFee({
        warpCore,
        originTokenAmount,
        destination: DEST,
        sender: SENDER,
        recipient: RECIPIENT,
      }),
    ).to.be.rejectedWith(/no destination_gas configured/);
  });
});
