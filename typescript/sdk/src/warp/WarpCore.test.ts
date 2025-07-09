import { expect } from 'chai';
import fs from 'fs';
import sinon from 'sinon';
import { parse as yamlParse } from 'yaml';

import {
  test1,
  test2,
  testCosmosChain,
  testSealevelChain,
  testVSXERC20,
  testXERC20,
  testXERC20Lockbox,
} from '../consts/testChains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ProviderType } from '../providers/ProviderType.js';
import { Token } from '../token/Token.js';
import { TokenStandard } from '../token/TokenStandard.js';
import { InterchainGasQuote } from '../token/adapters/ITokenAdapter.js';
import { ChainName } from '../types.js';

import { WarpCore } from './WarpCore.js';
import { WarpTxCategory } from './types.js';

const MOCK_LOCAL_QUOTE = { gasUnits: 2_000n, gasPrice: 100, fee: 200_000n };
const MOCK_INTERCHAIN_QUOTE = { amount: 20_000n };
const TRANSFER_AMOUNT = BigInt('1000000000000000000'); // 1 units @ 18 decimals
const MEDIUM_TRANSFER_AMOUNT = BigInt('15000000000000000000'); // 15 units @ 18 deicmals
const BIG_TRANSFER_AMOUNT = BigInt('100000000000000000000'); // 100 units @ 18 decimals
const MOCK_BALANCE = BigInt('10000000000000000000'); // 10 units @ 18 decimals
const MEDIUM_MOCK_BALANCE = BigInt('50000000000000000000'); // 50 units at @ 18 decimals
const MOCK_ADDRESS = '0x0000000000000000000000000000000000000001';

describe('WarpCore', () => {
  const multiProvider = MultiProtocolProvider.createTestMultiProtocolProvider();
  let warpCore: WarpCore;
  let evmHypNative: Token;
  let evmHypSynthetic: Token;
  let evmHypXERC20: Token;
  let evmHypVSXERC20: Token;
  let evmHypXERC20Lockbox: Token;
  let sealevelHypSynthetic: Token;
  let cwHypCollateral: Token;
  let cw20: Token;
  let cosmosIbc: Token;

  // Stub MultiProvider fee estimation to avoid real network calls
  sinon
    .stub(multiProvider, 'estimateTransactionFee')
    .returns(Promise.resolve(MOCK_LOCAL_QUOTE));

  it('Constructs', () => {
    const fromArgs = new WarpCore(multiProvider, [
      Token.FromChainMetadataNativeToken(test1),
    ]);
    const exampleConfig = yamlParse(
      fs.readFileSync('./src/warp/test-warp-core-config.yaml', 'utf-8'),
    );
    const fromConfig = WarpCore.FromConfig(multiProvider, exampleConfig);
    expect(fromArgs).to.be.instanceOf(WarpCore);
    expect(fromConfig).to.be.instanceOf(WarpCore);
    expect(fromConfig.tokens.length).to.equal(exampleConfig.tokens.length);

    warpCore = fromConfig;
    [
      evmHypNative,
      evmHypSynthetic,
      evmHypXERC20,
      evmHypVSXERC20,
      evmHypXERC20Lockbox,
      sealevelHypSynthetic,
      cwHypCollateral,
      cw20,
      cosmosIbc,
    ] = warpCore.tokens;
  });

  it('Finds tokens', () => {
    expect(
      warpCore.findToken(test1.name, evmHypNative.addressOrDenom),
    ).to.be.instanceOf(Token);
    expect(
      warpCore.findToken(
        testSealevelChain.name,
        sealevelHypSynthetic.addressOrDenom,
      ),
    ).to.be.instanceOf(Token);
    expect(
      warpCore.findToken(testCosmosChain.name, cw20.addressOrDenom),
    ).to.be.instanceOf(Token);
    expect(warpCore.findToken(test1.name, sealevelHypSynthetic.addressOrDenom))
      .to.be.null;
  });

  it('Gets transfer gas quote', async () => {
    const stubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getHypAdapter').returns({
        quoteTransferRemoteGas: () => Promise.resolve(MOCK_INTERCHAIN_QUOTE),
        isApproveRequired: () => Promise.resolve(false),
        populateTransferRemoteTx: () => Promise.resolve({}),
        isRevokeApprovalRequired: () => Promise.resolve(false),
      } as any),
    );

    const testQuote = async (
      token: Token,
      destination: ChainName,
      standard: TokenStandard,
      interchainQuote: InterchainGasQuote = MOCK_INTERCHAIN_QUOTE,
    ) => {
      const result = await warpCore.estimateTransferRemoteFees({
        originToken: token,
        destination,
        sender: MOCK_ADDRESS,
      });
      expect(
        result.localQuote.token.standard,
        `token local standard check for ${token.chainName} to ${destination}`,
      ).equals(standard);
      expect(
        result.localQuote.amount,
        `token local amount check for ${token.chainName} to ${destination}`,
      ).to.equal(MOCK_LOCAL_QUOTE.fee);
      expect(
        result.interchainQuote.token.standard,
        `token interchain standard check for ${token.chainName} to ${destination}`,
      ).equals(standard);
      expect(
        result.interchainQuote.amount,
        `token interchain amount check for ${token.chainName} to ${destination}`,
      ).to.equal(interchainQuote.amount);
    };

    await testQuote(evmHypNative, test1.name, TokenStandard.EvmNative);
    await testQuote(
      evmHypNative,
      testCosmosChain.name,
      TokenStandard.EvmNative,
    );
    await testQuote(
      evmHypNative,
      testSealevelChain.name,
      TokenStandard.EvmNative,
    );
    await testQuote(evmHypSynthetic, test2.name, TokenStandard.EvmNative);
    await testQuote(
      sealevelHypSynthetic,
      test2.name,
      TokenStandard.SealevelNative,
    );
    await testQuote(cosmosIbc, test1.name, TokenStandard.CosmosNative);
    // Note, this route uses an igp quote const config
    await testQuote(cwHypCollateral, test2.name, TokenStandard.CosmosNative, {
      amount: 1n,
      addressOrDenom: 'atom',
    });

    stubs.forEach((s) => s.restore());
  });

  it('Checks for destination collateral', async () => {
    const stubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getHypAdapter').returns({
        getBalance: () => Promise.resolve(MOCK_BALANCE),
        getBridgedSupply: () => Promise.resolve(MOCK_BALANCE),
        isRevokeApprovalRequired: () => Promise.resolve(false),
      } as any),
    );

    const testCollateral = async (
      token: Token,
      destination: ChainName,
      expectedBigResult: boolean,
    ) => {
      const smallResult = await warpCore.isDestinationCollateralSufficient({
        originTokenAmount: token.amount(TRANSFER_AMOUNT),
        destination,
      });
      expect(
        smallResult,
        `small collateral check for ${token.chainName} to ${destination}`,
      ).to.be.true;
      const bigResult = await warpCore.isDestinationCollateralSufficient({
        originTokenAmount: token.amount(BIG_TRANSFER_AMOUNT),
        destination,
      });
      expect(
        bigResult,
        `big collateral check for ${token.chainName} to ${destination}`,
      ).to.equal(expectedBigResult);
    };

    await testCollateral(evmHypNative, test2.name, true);
    await testCollateral(evmHypNative, testCosmosChain.name, false);
    await testCollateral(evmHypNative, testSealevelChain.name, true);
    await testCollateral(cwHypCollateral, test1.name, false);
    await testCollateral(evmHypXERC20, testVSXERC20.name, true);
    await testCollateral(evmHypVSXERC20, testXERC20.name, true);
    await testCollateral(evmHypXERC20Lockbox, testXERC20.name, true);
    await testCollateral(evmHypNative, testXERC20Lockbox.name, false);

    stubs.forEach((s) => s.restore());
  });

  it('Validates transfers', async () => {
    const balanceStubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getBalance').resolves({ amount: MOCK_BALANCE } as any),
    );
    const minimumTransferAmount = 10n;
    const quoteStubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getHypAdapter').returns({
        quoteTransferRemoteGas: () => Promise.resolve(MOCK_INTERCHAIN_QUOTE),
        isApproveRequired: () => Promise.resolve(false),
        populateTransferRemoteTx: () => Promise.resolve({}),
        getMinimumTransferAmount: () => Promise.resolve(minimumTransferAmount),
        getBalance: () => Promise.resolve(MOCK_BALANCE),
        getBridgedSupply: () => Promise.resolve(MOCK_BALANCE),
        getMintLimit: () => Promise.resolve(MEDIUM_MOCK_BALANCE),
        getMintMaxLimit: () => Promise.resolve(MEDIUM_MOCK_BALANCE),
        isRevokeApprovalRequired: () => Promise.resolve(false),
      } as any),
    );

    const validResult = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(TRANSFER_AMOUNT),
      destination: test2.name,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(validResult).to.be.null;

    const invalidChain = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(TRANSFER_AMOUNT),
      destination: 'fakechain',
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(Object.keys(invalidChain || {})[0]).to.equal('destination');

    const invalidRecipient = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(TRANSFER_AMOUNT),
      destination: testCosmosChain.name,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(Object.keys(invalidRecipient || {})[0]).to.equal('recipient');

    const invalidAmount = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(-10),
      destination: test2.name,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(Object.keys(invalidAmount || {})[0]).to.equal('amount');

    const insufficientAmount = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(minimumTransferAmount - 1n),
      destination: test2.name,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(Object.keys(insufficientAmount || {})[0]).to.equal('amount');

    const insufficientBalance = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(BIG_TRANSFER_AMOUNT),
      destination: test2.name,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(Object.keys(insufficientBalance || {})[0]).to.equal('amount');

    const validXERC20TokenResult = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(TRANSFER_AMOUNT),
      destination: testXERC20.name,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(validXERC20TokenResult).to.be.null;

    const invalidRateLimit = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(BIG_TRANSFER_AMOUNT),
      destination: testXERC20.name,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(Object.values(invalidRateLimit || {})[0]).to.equal(
      'Rate limit exceeded on destination',
    );

    const invalidXERC20LockboxTokenRateLimit = await warpCore.validateTransfer({
      originTokenAmount: evmHypXERC20.amount(BIG_TRANSFER_AMOUNT),
      destination: testXERC20Lockbox.name,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(Object.values(invalidXERC20LockboxTokenRateLimit || {})[0]).to.equal(
      'Rate limit exceeded on destination',
    );

    const invalidCollateralXERC20LockboxToken = await warpCore.validateTransfer(
      {
        originTokenAmount: evmHypXERC20.amount(MEDIUM_TRANSFER_AMOUNT),
        destination: testXERC20Lockbox.name,
        recipient: MOCK_ADDRESS,
        sender: MOCK_ADDRESS,
      },
    );
    expect(
      Object.values(invalidCollateralXERC20LockboxToken || {})[0],
    ).to.equal('Insufficient collateral on destination');

    balanceStubs.forEach((s) => s.restore());
    quoteStubs.forEach((s) => s.restore());
  });

  it('Gets transfer remote txs', async () => {
    const coreStub = sinon
      .stub(warpCore, 'isApproveRequired')
      .returns(Promise.resolve(false));

    const adapterStubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getHypAdapter').returns({
        quoteTransferRemoteGas: () => Promise.resolve(MOCK_INTERCHAIN_QUOTE),
        populateTransferRemoteTx: () => Promise.resolve({}),
        isRevokeApprovalRequired: () => Promise.resolve(false),
      } as any),
    );

    const testGetTxs = async (
      token: Token,
      destination: ChainName,
      providerType = ProviderType.EthersV5,
    ) => {
      const result = await warpCore.getTransferRemoteTxs({
        originTokenAmount: token.amount(TRANSFER_AMOUNT),
        destination,
        sender: MOCK_ADDRESS,
        recipient: MOCK_ADDRESS,
      });
      expect(result.length).to.equal(1);
      expect(
        result[0],
        `transfer tx for ${token.chainName} to ${destination}`,
      ).to.eql({
        category: WarpTxCategory.Transfer,
        transaction: {},
        type: providerType,
      });
    };

    await testGetTxs(evmHypNative, test1.name);
    await testGetTxs(evmHypNative, testCosmosChain.name);
    await testGetTxs(evmHypNative, testSealevelChain.name);
    await testGetTxs(evmHypSynthetic, test2.name);
    await testGetTxs(sealevelHypSynthetic, test2.name, ProviderType.SolanaWeb3);
    await testGetTxs(cwHypCollateral, test1.name, ProviderType.CosmJsWasm);
    await testGetTxs(cosmosIbc, test1.name, ProviderType.CosmJs);

    coreStub.restore();
    adapterStubs.forEach((s) => s.restore());
  });
});
