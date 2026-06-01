import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import { expect } from 'chai';
import { Wallet } from 'ethers';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  OffchainQuotedLinearFee,
  OffchainQuotedLinearFee__factory,
} from '@hyperlane-xyz/core';
import { type FeeReadContext } from '@hyperlane-xyz/provider-sdk/fee';
import {
  WARP_QUOTE_AMOUNT_WILDCARD,
  WARP_TARGET_ROUTER_NONE,
  WILDCARD_BYTES32,
} from '@hyperlane-xyz/provider-sdk/quote';
import { assert } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmPrivateKeyQuoteSigner } from './EvmPrivateKeyQuoteSigner.js';
import { EvmQuoteArtifactManager } from './EvmQuoteArtifactManager.js';

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';

const MAX_FEE = 1_000n;
const HALF_AMOUNT = 1_000_000n;
const DEST_DOMAIN = 137;
const ROUTER = '0x' + 'aa'.repeat(32);

describe('EvmQuoteReader (hardhat)', () => {
  const chain = TestChainName.test1;

  let owner: SignerWithAddress;
  let multiProvider: MultiProvider;
  let token: ERC20Test;
  let fee: OffchainQuotedLinearFee;
  let quoteSignerWallet: Wallet;

  before(async () => {
    [owner] = await hre.ethers.getSigners();
    multiProvider = MultiProvider.createTestMultiProvider({ signer: owner });

    const erc20 = new ERC20Test__factory(owner);
    token = await erc20.deploy('fake', 'FAKE', '100000000000000000000', 18);
    await token.deployed();

    quoteSignerWallet = Wallet.fromMnemonic(TEST_MNEMONIC, "m/44'/60'/0'/0/1");

    const offchain = new OffchainQuotedLinearFee__factory(owner);
    fee = await offchain.deploy(
      quoteSignerWallet.address,
      token.address,
      MAX_FEE,
      HALF_AMOUNT,
      owner.address,
    );
    await fee.deployed();
  });

  function makeManager(context: FeeReadContext) {
    return new EvmQuoteArtifactManager(
      multiProvider,
      chain,
      fee.address,
      context,
    );
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  it('returns no entries before any quote is submitted', async () => {
    const reader = makeManager({
      knownRoutersPerDomain: { [DEST_DOMAIN]: new Set([ROUTER]) },
    }).createReader();
    expect(await reader.readStandingQuotes()).to.deep.equal([]);
  });

  it('reads a standing quote keyed by a specific recipient', async () => {
    const context: FeeReadContext = {
      knownRoutersPerDomain: { [DEST_DOMAIN]: new Set([ROUTER]) },
    };
    const writer = makeManager(context).createWriter(
      new EvmPrivateKeyQuoteSigner(quoteSignerWallet.privateKey),
      owner,
    );
    const issuedAt = nowSec();
    const expiry = issuedAt + 3600;
    await writer.submitQuote({
      scope: {
        destination: DEST_DOMAIN,
        recipient: ROUTER,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      params: { maxFee: 4_321n, halfAmount: 8_765n },
      issuedAt,
      expiry,
    });

    const entries = await makeManager(context)
      .createReader()
      .readStandingQuotes();
    const match = entries.find((e) => e.scope.recipient === ROUTER);
    assert(match, 'expected a standing entry for ROUTER recipient');
    expect(match.scope.destination).to.equal(DEST_DOMAIN);
    expect(match.params.maxFee).to.equal(4_321n);
    expect(match.params.halfAmount).to.equal(8_765n);
    expect(match.issuedAt).to.equal(issuedAt);
    expect(match.expiry).to.equal(expiry);
  });

  it('reads a standing quote keyed by the wildcard recipient', async () => {
    const context: FeeReadContext = {
      knownRoutersPerDomain: { [DEST_DOMAIN]: new Set([ROUTER]) },
    };
    const writer = makeManager(context).createWriter(
      new EvmPrivateKeyQuoteSigner(quoteSignerWallet.privateKey),
      owner,
    );
    const issuedAt = nowSec() + 1;
    const expiry = issuedAt + 7200;
    await writer.submitQuote({
      scope: {
        destination: DEST_DOMAIN,
        recipient: WILDCARD_BYTES32,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      params: { maxFee: 11n, halfAmount: 22n },
      issuedAt,
      expiry,
    });

    const entries = await makeManager(context)
      .createReader()
      .readStandingQuotes();
    const match = entries.find(
      (e) =>
        e.scope.destination === DEST_DOMAIN &&
        e.scope.recipient === WILDCARD_BYTES32,
    );
    assert(match, 'expected a standing entry for the wildcard recipient');
    expect(match.params.maxFee).to.equal(11n);
    expect(match.params.halfAmount).to.equal(22n);
    expect(match.issuedAt).to.equal(issuedAt);
    expect(match.expiry).to.equal(expiry);
  });

  it('reads a quote keyed by a non-router recipient when passed via extraRecipients', async () => {
    const context: FeeReadContext = {
      knownRoutersPerDomain: { [DEST_DOMAIN]: new Set([ROUTER]) },
    };
    const extra = '0x' + 'cd'.repeat(32);
    const writer = makeManager(context).createWriter(
      new EvmPrivateKeyQuoteSigner(quoteSignerWallet.privateKey),
      owner,
    );
    const issuedAt = nowSec() + 2;
    const expiry = issuedAt + 7200;
    await writer.submitQuote({
      scope: {
        destination: DEST_DOMAIN,
        recipient: extra,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      params: { maxFee: 33n, halfAmount: 44n },
      issuedAt,
      expiry,
    });

    // Without extras: the reader doesn't probe arbitrary recipients, so the
    // entry stays invisible to the cross-VM read.
    const withoutExtras = await makeManager(context)
      .createReader()
      .readStandingQuotes();
    expect(
      withoutExtras.find((e) => e.scope.recipient === extra),
      'reader should not discover arbitrary recipients without extras',
    ).to.equal(undefined);

    // With extras: the reader probes (DEST_DOMAIN, extra) and finds it.
    const withExtras = await makeManager(context)
      .createReader()
      .readStandingQuotes({ extraRecipients: new Set([extra]) });
    const match = withExtras.find((e) => e.scope.recipient === extra);
    assert(match, 'extras-probe should discover the arbitrary recipient entry');
    expect(match.scope.destination).to.equal(DEST_DOMAIN);
    expect(match.params.maxFee).to.equal(33n);
    expect(match.params.halfAmount).to.equal(44n);
  });

  it('enumerateCandidates yields only `targetRouter === none` scopes (EVM has no CC dimension)', async () => {
    const reader = makeManager({
      knownRoutersPerDomain: {
        [DEST_DOMAIN]: new Set([ROUTER, '0x' + 'bb'.repeat(32)]),
      },
    }).createReader();
    const candidates = await reader.enumerateCandidates();
    expect(candidates.length).to.be.greaterThan(0);
    expect(
      candidates.every((s) => s.targetRouter === WARP_TARGET_ROUTER_NONE),
    ).to.equal(true);
  });
});
