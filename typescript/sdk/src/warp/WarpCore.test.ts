import { expect } from 'chai';
import fs from 'fs';
import sinon from 'sinon';
import { parse as yamlParse } from 'yaml';

import {
  test1,
  test2,
  testCosmosChain,
  testScale1,
  testScale2,
  testSealevelChain,
  testVSXERC20,
  testXERC20,
  testXERC20Lockbox,
} from '../consts/testChains.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ProviderType } from '../providers/ProviderType.js';
import { Token } from '../token/Token.js';
import { TokenAmount } from '../token/TokenAmount.js';
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
  let evmHypNativeScale1: Token;
  let evmHypNativeScale2: Token;
  let evmHypSynthetic: Token;
  let evmHypXERC20: Token;
  let evmHypVSXERC20: Token;
  let evmHypXERC20Lockbox: Token;
  let evmHypCollateralFiat: Token;
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
      evmHypNativeScale1,
      evmHypNativeScale2,
      evmHypCollateralFiat,
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
        quoteTransferRemoteGas: () =>
          Promise.resolve({
            igpQuote: MOCK_INTERCHAIN_QUOTE,
            tokenFeeQuote: MOCK_INTERCHAIN_QUOTE,
          }),
        isApproveRequired: () => Promise.resolve(false),
        populateTransferRemoteTx: () => Promise.resolve({}),
        isRevokeApprovalRequired: () => Promise.resolve(false),
      } as any),
    );

    const testQuote = async (
      token: Token,
      destination: ChainName,
      standard: TokenStandard,
      interchainQuote: InterchainGasQuote = {
        igpQuote: MOCK_INTERCHAIN_QUOTE,
        tokenFeeQuote: MOCK_INTERCHAIN_QUOTE,
      },
    ) => {
      const tokenAmount = new TokenAmount(0, token);
      const result = await warpCore.estimateTransferRemoteFees({
        originTokenAmount: tokenAmount,
        destination,
        sender: MOCK_ADDRESS,
        recipient: MOCK_ADDRESS,
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
      ).to.equal(interchainQuote.igpQuote.amount);
      expect(
        result.tokenFeeQuote?.amount,
        `token fee amount check for ${token.chainName} to ${destination}`,
      ).to.equal(interchainQuote.tokenFeeQuote?.amount);
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
      igpQuote: { amount: 1n, addressOrDenom: 'atom' },
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

  it('Checks for destination collateral with scaling factors', async () => {
    const stubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getHypAdapter').returns({
        getBalance: () => Promise.resolve(10n),
        getBridgedSupply: () => Promise.resolve(10n),
        isRevokeApprovalRequired: () => Promise.resolve(false),
      } as any),
    );

    const testCollateral = async (
      token: Token,
      destination: ChainName,
      amount: bigint,
      expectedResult: boolean,
    ) => {
      const result = await warpCore.isDestinationCollateralSufficient({
        originTokenAmount: token.amount(amount),
        destination,
      });

      expect(
        result,
        `collateral check for ${token.chainName} to ${destination}`,
      ).to.equal(expectedResult);
    };

    await testCollateral(evmHypNativeScale1, testScale2.name, 10n, false);
    await testCollateral(evmHypNativeScale1, testScale2.name, 1n, true);
    await testCollateral(evmHypNativeScale2, testScale1.name, 10n, true);
    await testCollateral(evmHypNativeScale2, testScale1.name, 100n, true);
    await testCollateral(evmHypNativeScale2, testScale1.name, 101n, false);

    stubs.forEach((s) => s.restore());
  });

  it('Validates transfers', async () => {
    const balanceStubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getBalance').resolves({ amount: MOCK_BALANCE } as any),
    );
    const minimumTransferAmount = 10n;
    const quoteStubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getHypAdapter').returns({
        quoteTransferRemoteGas: () =>
          Promise.resolve({ igpQuote: MOCK_INTERCHAIN_QUOTE }),
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

    const invalidCollateralFiatTokenRateLimit = await warpCore.validateTransfer(
      {
        originTokenAmount: evmHypNative.amount(BIG_TRANSFER_AMOUNT),
        destination: evmHypCollateralFiat.chainName,
        recipient: MOCK_ADDRESS,
        sender: MOCK_ADDRESS,
      },
    );
    expect(
      Object.values(invalidCollateralFiatTokenRateLimit || {})[0],
    ).to.equal('Rate limit exceeded on destination');

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

  it('Validates destination token routing', async () => {
    const balanceStubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getBalance').resolves({ amount: MOCK_BALANCE } as any),
    );
    const minimumTransferAmount = 10n;
    const quoteStubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getHypAdapter').returns({
        quoteTransferRemoteGas: () =>
          Promise.resolve({ igpQuote: MOCK_INTERCHAIN_QUOTE }),
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

    const invalidDestinationToken = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(TRANSFER_AMOUNT),
      destination: test2.name,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
      destinationToken: evmHypCollateralFiat,
    });
    expect(Object.values(invalidDestinationToken || {})[0]).to.equal(
      `Destination token chain mismatch for ${test2.name}`,
    );

    const validDestinationToken = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(TRANSFER_AMOUNT),
      destination: test2.name,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
      destinationToken: evmHypSynthetic,
    });
    expect(validDestinationToken).to.be.null;

    balanceStubs.forEach((s) => s.restore());
    quoteStubs.forEach((s) => s.restore());
  });

  it('Requires explicit destination token for ambiguous routes', async () => {
    const ambiguousConfig = yamlParse(
      fs.readFileSync('./src/warp/test-warp-core-config.yaml', 'utf-8'),
    );
    const extraTest2Address = '0x9876543210987654321098765432109876543219';

    const test1Token = ambiguousConfig.tokens.find(
      (token: any) =>
        token.chainName === test1.name &&
        token.addressOrDenom === evmHypNative.addressOrDenom,
    );
    test1Token.connections.push({
      token: `ethereum|${test2.name}|${extraTest2Address}`,
    });
    ambiguousConfig.tokens.push({
      chainName: test2.name,
      standard: TokenStandard.EvmHypSynthetic,
      decimals: 18,
      symbol: 'ETH2',
      name: 'Ether 2',
      addressOrDenom: extraTest2Address,
      connections: [
        {
          token: `ethereum|${test1.name}|${evmHypNative.addressOrDenom}`,
        },
      ],
    });

    const ambiguousWarpCore = WarpCore.FromConfig(
      multiProvider,
      ambiguousConfig,
    );
    const ambiguousOrigin = ambiguousWarpCore.findToken(
      test1.name,
      evmHypNative.addressOrDenom,
    );
    const extraDestination = ambiguousWarpCore.findToken(
      test2.name,
      extraTest2Address,
    );
    expect(ambiguousOrigin).to.not.be.null;
    expect(extraDestination).to.not.be.null;

    const balanceStubs = ambiguousWarpCore.tokens.map((t) =>
      sinon.stub(t, 'getBalance').resolves({ amount: MOCK_BALANCE } as any),
    );
    const minimumTransferAmount = 10n;
    const quoteStubs = ambiguousWarpCore.tokens.map((t) =>
      sinon.stub(t, 'getHypAdapter').returns({
        quoteTransferRemoteGas: () =>
          Promise.resolve({ igpQuote: MOCK_INTERCHAIN_QUOTE }),
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

    const ambiguousValidation = await ambiguousWarpCore.validateTransfer({
      originTokenAmount: ambiguousOrigin!.amount(TRANSFER_AMOUNT),
      destination: test2.name,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(Object.values(ambiguousValidation || {})[0]).to.equal(
      `Ambiguous route to ${test2.name}; specify destination token`,
    );

    const explicitValidation = await ambiguousWarpCore.validateTransfer({
      originTokenAmount: ambiguousOrigin!.amount(TRANSFER_AMOUNT),
      destination: test2.name,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
      destinationToken: extraDestination!,
    });
    expect(explicitValidation).to.be.null;

    balanceStubs.forEach((s) => s.restore());
    quoteStubs.forEach((s) => s.restore());
  });

  it('Includes token fee in MultiCollateral approval debit', async () => {
    const tokenFeeAmount = 123n;
    const originalCollateralAddress = evmHypNative.collateralAddressOrDenom;
    (evmHypNative as any).collateralAddressOrDenom =
      evmHypNative.addressOrDenom;

    const originMultiStub = sinon
      .stub(evmHypNative, 'isMultiCollateralToken')
      .returns(true);
    const destinationMultiStub = sinon
      .stub(evmHypSynthetic, 'isMultiCollateralToken')
      .returns(true);

    const quoteTransferRemoteToGas = sinon.stub().resolves({
      igpQuote: { amount: 1n },
      tokenFeeQuote: {
        addressOrDenom: evmHypNative.addressOrDenom,
        amount: tokenFeeAmount,
      },
    });
    const isApproveRequired = sinon.stub().resolves(true);
    const populateApproveTx = sinon.stub().resolves({});
    const populateTransferRemoteToTx = sinon.stub().resolves({});

    const adapterStub = sinon.stub(evmHypNative, 'getHypAdapter').returns({
      quoteTransferRemoteToGas,
      isApproveRequired,
      populateApproveTx,
      populateTransferRemoteToTx,
      isRevokeApprovalRequired: () => Promise.resolve(false),
    } as any);

    try {
      const result = await warpCore.getTransferRemoteTxs({
        originTokenAmount: evmHypNative.amount(TRANSFER_AMOUNT),
        destination: test2.name,
        sender: MOCK_ADDRESS,
        recipient: MOCK_ADDRESS,
        destinationToken: evmHypSynthetic,
      });

      expect(result.length).to.equal(2);
      sinon.assert.calledWithExactly(
        isApproveRequired,
        MOCK_ADDRESS,
        evmHypNative.addressOrDenom,
        TRANSFER_AMOUNT + tokenFeeAmount,
      );
      sinon.assert.calledWithMatch(populateApproveTx, {
        weiAmountOrId: TRANSFER_AMOUNT + tokenFeeAmount,
        recipient: evmHypNative.addressOrDenom,
      });
    } finally {
      adapterStub.restore();
      originMultiStub.restore();
      destinationMultiStub.restore();
      (evmHypNative as any).collateralAddressOrDenom =
        originalCollateralAddress;
    }
  });

  it('Uses destination router-aware quote for MultiCollateral fees', async () => {
    const originMultiStub = sinon
      .stub(evmHypNative, 'isMultiCollateralToken')
      .returns(true);
    const destinationMultiStub = sinon
      .stub(evmHypSynthetic, 'isMultiCollateralToken')
      .returns(true);

    const quoteTransferRemoteToGas = sinon.stub().resolves({
      igpQuote: { amount: 42n },
      tokenFeeQuote: {
        addressOrDenom: evmHypNative.addressOrDenom,
        amount: 11n,
      },
    });

    const adapterStub = sinon.stub(evmHypNative, 'getHypAdapter').returns({
      quoteTransferRemoteToGas,
    } as any);

    try {
      const quote = await warpCore.getInterchainTransferFee({
        originTokenAmount: evmHypNative.amount(TRANSFER_AMOUNT),
        destination: test2.name,
        sender: MOCK_ADDRESS,
        recipient: MOCK_ADDRESS,
        destinationToken: evmHypSynthetic,
      });

      expect(quote.igpQuote.amount).to.equal(42n);
      expect(quote.tokenFeeQuote?.amount).to.equal(11n);
      sinon.assert.calledWithMatch(quoteTransferRemoteToGas, {
        destination: test2.domainId,
        recipient: MOCK_ADDRESS,
        amount: TRANSFER_AMOUNT,
        targetRouter: evmHypSynthetic.addressOrDenom,
      });
    } finally {
      adapterStub.restore();
      originMultiStub.restore();
      destinationMultiStub.restore();
    }
  });

  it('Gets transfer remote txs', async () => {
    const coreStub = sinon
      .stub(warpCore, 'isApproveRequired')
      .returns(Promise.resolve(false));

    const adapterStubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getHypAdapter').returns({
        quoteTransferRemoteGas: () =>
          Promise.resolve({ igpQuote: MOCK_INTERCHAIN_QUOTE }),
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
