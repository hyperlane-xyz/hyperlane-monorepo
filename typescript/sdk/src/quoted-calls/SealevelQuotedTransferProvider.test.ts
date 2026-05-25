import { Connection, PublicKey } from '@solana/web3.js';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import sinon from 'sinon';
import { type Hex, hexToBytes, keccak256 } from 'viem';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

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

describe('SealevelQuotedTransferProvider.buildQuotedTransferTxs', () => {
  const ORIGIN = 'solanamainnet';
  const DEST = 'arbitrum';
  const DEST_DOMAIN = 42161;
  const ROUTER_PUBKEY = 'SysvarRent111111111111111111111111111111111';
  const SENDER = '11111111111111111111111111111111';
  const RECIPIENT: Hex = `0x${'aa'.repeat(20)}`;
  const FEE_PROGRAM = new PublicKey('11111111111111111111111111111111');
  const FEE_ACCOUNT = new PublicKey(
    'SysvarRent111111111111111111111111111111111',
  );

  function makeAdapter(opts: { feeConfig: object | null }) {
    const adapter = sinon.createStubInstance(SealevelHypNativeAdapter);
    adapter.getTokenAccountData.resolves(
      new SealevelHyperlaneTokenData({
        mailbox: new Uint8Array(32),
        mailbox_process_authority: new Uint8Array(32),
        fee_config: opts.feeConfig,
      }),
    );
    adapter.getRouterAddress.resolves(
      Buffer.from(new Uint8Array(32).fill(0xaa)),
    );
    return adapter;
  }

  function makeWarpCore(adapter: SealevelHypNativeAdapter) {
    const token = sinon.createStubInstance(Token);
    Object.defineProperty(token, 'chainName', { value: ORIGIN });
    Object.defineProperty(token, 'addressOrDenom', { value: ROUTER_PUBKEY });
    token.getHypAdapter.returns(adapter);

    const originTokenAmount = sinon.createStubInstance(TokenAmount);
    Object.defineProperty(originTokenAmount, 'token', { value: token });
    Object.defineProperty(originTokenAmount, 'amount', { value: 1000n });

    const warpCore = sinon.createStubInstance(WarpCore);
    Object.defineProperty(warpCore, 'multiProvider', {
      value: { getDomainId: () => DEST_DOMAIN, getChainName: () => DEST },
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

  function makeClient(warpEntry: SealevelQuoteV2Entry) {
    const client = sinon.createStubInstance(FeeQuotingV2Client);
    client.getWarpQuote.resolves(warpEntry);
    return client;
  }

  function makeProvider(client: FeeQuotingV2Client) {
    return new SealevelQuotedTransferProvider({
      feeQuotingClient: client,
      connection: sinon.createStubInstance(Connection),
      feeProgramId: FEE_PROGRAM,
      feeAccount: FEE_ACCOUNT,
    });
  }

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
