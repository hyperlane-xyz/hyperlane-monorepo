import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers.js';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet } from 'ethers';
import hre from 'hardhat';

import {
  ERC20Test,
  ERC20Test__factory,
  OffchainQuotedLinearFee,
  OffchainQuotedLinearFee__factory,
} from '@hyperlane-xyz/core';
import {
  WARP_QUOTE_AMOUNT_WILDCARD,
  WARP_TARGET_ROUTER_NONE,
  WILDCARD_BYTES32,
  WarpQuoteAmountKind,
} from '@hyperlane-xyz/provider-sdk/quote';
import { assert } from '@hyperlane-xyz/utils';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';

import { EvmPrivateKeyQuoteSigner } from './EvmPrivateKeyQuoteSigner.js';
import { EvmQuoteArtifactManager } from './EvmQuoteArtifactManager.js';
import {
  buildEvmSignedQuoteSignable,
  buildEvmSignedQuoteTuple,
} from './WarpSignedQuoteEip712.js';

chai.use(chaiAsPromised);
const { expect } = chai;

// Anvil / hardhat default test mnemonic — public, no live funds.
const TEST_MNEMONIC =
  'test test test test test test test test test test test junk';

const MAX_FEE = 1_000n;
const HALF_AMOUNT = 1_000_000n;
const DEST_DOMAIN = 137;
const RECIPIENT = WILDCARD_BYTES32;

describe('EvmQuoteWriter (hardhat)', () => {
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

  function makeWriter(privateKey: string = quoteSignerWallet.privateKey) {
    const manager = new EvmQuoteArtifactManager(
      multiProvider,
      chain,
      fee.address,
      { knownRoutersPerDomain: {} },
    );
    return manager.createWriter(
      new EvmPrivateKeyQuoteSigner(privateKey),
      owner,
    );
  }

  // Derive "now" from the chain's latest block rather than wall-clock time so
  // these tests stay correct when an earlier hardhat suite warps the shared
  // node's block.timestamp (e.g. the timelock tests) ahead of real time.
  async function nowSec() {
    const { timestamp } = await hre.ethers.provider.getBlock('latest');
    return timestamp;
  }

  it('submits a standing quote and records it on-chain', async () => {
    const writer = makeWriter();
    const issuedAt = await nowSec();
    const expiry = issuedAt + 3600;

    await writer.submitQuote({
      scope: {
        destination: DEST_DOMAIN,
        recipient: RECIPIENT,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      params: { maxFee: 1234n, halfAmount: 5678n },
      issuedAt,
      expiry,
    });

    const stored = await fee.quotes(DEST_DOMAIN, RECIPIENT);
    expect(stored.maxFee.toString()).to.equal('1234');
    expect(stored.halfAmount.toString()).to.equal('5678');
    expect(stored.issuedAt).to.equal(issuedAt);
    expect(stored.expiry).to.equal(expiry);
  });

  it('rejects when the quote signer is not authorized by the contract', async () => {
    const otherWallet = Wallet.fromMnemonic(TEST_MNEMONIC, "m/44'/60'/0'/0/9");
    expect(otherWallet.address).to.not.equal(quoteSignerWallet.address);
    const writer = makeWriter(otherWallet.privateKey);
    const issuedAt = await nowSec();

    await expect(
      writer.submitQuote({
        scope: {
          destination: DEST_DOMAIN,
          recipient: RECIPIENT,
          targetRouter: WARP_TARGET_ROUTER_NONE,
          amount: WARP_QUOTE_AMOUNT_WILDCARD,
        },
        params: { maxFee: 1n, halfAmount: 2n },
        issuedAt,
        expiry: issuedAt + 3600,
      }),
    ).to.be.rejectedWith(/not authorized/);
  });

  it('rejects standing quotes with a non-wildcard amount', async () => {
    const writer = makeWriter();
    const issuedAt = await nowSec();

    await expect(
      writer.submitQuote({
        scope: {
          destination: DEST_DOMAIN,
          recipient: RECIPIENT,
          targetRouter: WARP_TARGET_ROUTER_NONE,
          amount: { kind: WarpQuoteAmountKind.value, value: 42n },
        },
        params: { maxFee: 1n, halfAmount: 2n },
        issuedAt,
        expiry: issuedAt + 3600,
      }),
    ).to.be.rejectedWith(/wildcard/);
  });

  // Hardhat's EDR runtime reports custom-error reverts only as a 4-byte
  // selector in the error message (e.g. `0x8727a7f9` for `QuoteExpired()`),
  // not by name. Compute the selector from the ABI at test time so the
  // assertion stays in sync with the contract source.
  const iface = OffchainQuotedLinearFee__factory.createInterface();
  function errorSelector(name: string): string {
    return iface.getSighash(iface.getError(name));
  }

  it('rejects an expired quote (on-chain QuoteExpired)', async () => {
    const writer = makeWriter();
    const past = (await nowSec()) - 3600;
    const error = await writer
      .submitQuote({
        scope: {
          destination: 200,
          recipient: RECIPIENT,
          targetRouter: WARP_TARGET_ROUTER_NONE,
          amount: WARP_QUOTE_AMOUNT_WILDCARD,
        },
        params: { maxFee: 1n, halfAmount: 2n },
        issuedAt: past,
        expiry: past + 30,
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert(error, 'submitQuote should have rejected');
    expect(String(error)).to.include(errorSelector('QuoteExpired'));
  });

  it('submits a transient quote without writing standing storage', async () => {
    const writer = makeWriter();
    // Fresh destination slot — any standing entry here is unambiguously
    // caused by this test, so reading the standing mapping back as zero
    // is a real assertion about the transient code path.
    const TRANSIENT_DEST = 999;
    // Pick a future timestamp so the on-chain `block.timestamp > expiry`
    // check passes when the tx is mined. issuedAt === expiry keeps the
    // quote transient (per AbstractOffchainQuoter routing).
    const ts = (await nowSec()) + 60;
    await writer.submitQuote({
      scope: {
        destination: TRANSIENT_DEST,
        recipient: RECIPIENT,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: { kind: WarpQuoteAmountKind.value, value: 1_000n },
      },
      params: { maxFee: 42n, halfAmount: 84n },
      issuedAt: ts,
      expiry: ts,
    });

    // Transient writes go to EIP-1153 transient storage and clear at tx end,
    // so the standing `quotes` mapping at this slot must remain empty.
    const stored = await fee.quotes(TRANSIENT_DEST, RECIPIENT);
    expect(stored.expiry).to.equal(0);
    expect(stored.maxFee.toString()).to.equal('0');
  });

  it('binds submitter: a different sender cannot broadcast a captured signed quote', async () => {
    const otherSigner = (await hre.ethers.getSigners())[1];
    assert(otherSigner.address !== owner.address, 'need a second signer');

    // Build a signed quote bound to `owner.address` (the configured submitter).
    const issuedAt = await nowSec();
    const sq = buildEvmSignedQuoteTuple(
      {
        scope: {
          destination: 300,
          recipient: RECIPIENT,
          targetRouter: WARP_TARGET_ROUTER_NONE,
          amount: WARP_QUOTE_AMOUNT_WILDCARD,
        },
        params: { maxFee: 1n, halfAmount: 2n },
        issuedAt,
        expiry: issuedAt + 3600,
      },
      '0x' + '11'.repeat(32),
      owner.address,
    );
    const chainId = await owner.getChainId();
    const signable = buildEvmSignedQuoteSignable(sq, chainId, fee.address);
    const { signature } = await new EvmPrivateKeyQuoteSigner(
      quoteSignerWallet.privateKey,
    ).sign(signable);
    const sigHex = `0x${Buffer.from(signature).toString('hex')}`;

    const error = await fee
      .connect(otherSigner)
      .submitQuote(sq, sigHex)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert(error, 'submission from a different sender should have rejected');
    expect(String(error)).to.include(errorSelector('InvalidSubmitter'));
  });

  it('rejects a stale standing-quote update (on-chain StaleQuote)', async () => {
    const writer = makeWriter();
    const dest = 201;
    const t = await nowSec();
    await writer.submitQuote({
      scope: {
        destination: dest,
        recipient: RECIPIENT,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      params: { maxFee: 1n, halfAmount: 2n },
      issuedAt: t,
      expiry: t + 3600,
    });
    const error = await writer
      .submitQuote({
        scope: {
          destination: dest,
          recipient: RECIPIENT,
          targetRouter: WARP_TARGET_ROUTER_NONE,
          amount: WARP_QUOTE_AMOUNT_WILDCARD,
        },
        params: { maxFee: 1n, halfAmount: 2n },
        issuedAt: t - 60,
        expiry: t + 3600,
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert(error, 'submitQuote should have rejected');
    expect(String(error)).to.include(errorSelector('StaleQuote'));
  });
});
