import { expect } from 'chai';
import fs from 'fs';
import sinon from 'sinon';
import { parse as yamlParse } from 'yaml';

import { chainMetadata } from '../consts/chainMetadata.js';
import { Chains } from '../consts/chains.js';
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
const BIG_TRANSFER_AMOUNT = BigInt('100000000000000000000'); // 100 units @ 18 decimals
const MOCK_BALANCE = BigInt('10000000000000000000'); // 10 units @ 18 decimals
const MOCK_ADDRESS = '0x0000000000000000000000000000000000000001';

describe('WarpCore', () => {
  const multiProvider = new MultiProtocolProvider();
  let warpCore: WarpCore;
  let evmHypNative: Token;
  let evmHypSynthetic: Token;
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
      Token.FromChainMetadataNativeToken(chainMetadata[Chains.ethereum]),
    ]);
    const exampleConfig = yamlParse(
      fs.readFileSync('./src/warp/example-warp-core-config.yaml', 'utf-8'),
    );
    const fromConfig = WarpCore.FromConfig(multiProvider, exampleConfig);
    expect(fromArgs).to.be.instanceOf(WarpCore);
    expect(fromConfig).to.be.instanceOf(WarpCore);
    expect(fromConfig.tokens.length).to.equal(exampleConfig.tokens.length);

    warpCore = fromConfig;
    [
      evmHypNative,
      evmHypSynthetic,
      sealevelHypSynthetic,
      cwHypCollateral,
      cw20,
      cosmosIbc,
    ] = warpCore.tokens;
  });

  it('Finds tokens', () => {
    expect(
      warpCore.findToken(Chains.ethereum, evmHypNative.addressOrDenom),
    ).to.be.instanceOf(Token);
    expect(
      warpCore.findToken(Chains.ethereum, sealevelHypSynthetic.addressOrDenom),
    ).to.be.null;
    expect(
      warpCore.findToken(Chains.neutron, cw20.addressOrDenom),
    ).to.be.instanceOf(Token);
  });

  it('Gets transfer gas quote', async () => {
    const stubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getHypAdapter').returns({
        quoteTransferRemoteGas: () => Promise.resolve(MOCK_INTERCHAIN_QUOTE),
        isApproveRequired: () => Promise.resolve(false),
        populateTransferRemoteTx: () => Promise.resolve({}),
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

    await testQuote(evmHypNative, Chains.arbitrum, TokenStandard.EvmNative);
    await testQuote(evmHypNative, Chains.neutron, TokenStandard.EvmNative);
    await testQuote(evmHypNative, Chains.solana, TokenStandard.EvmNative);
    await testQuote(evmHypSynthetic, Chains.ethereum, TokenStandard.EvmNative);
    await testQuote(
      sealevelHypSynthetic,
      Chains.ethereum,
      TokenStandard.SealevelNative,
    );
    await testQuote(cosmosIbc, Chains.arbitrum, TokenStandard.CosmosNative);
    // Note, this route uses an igp quote const config
    await testQuote(
      cwHypCollateral,
      Chains.arbitrum,
      TokenStandard.CosmosNative,
      {
        amount: 1n,
        addressOrDenom: 'untrn',
      },
    );

    stubs.forEach((s) => s.restore());
  });

  it('Checks for destination collateral', async () => {
    const stubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getHypAdapter').returns({
        getBalance: () => Promise.resolve(MOCK_BALANCE),
      } as any),
    );

    const testCollateral = async (
      token: Token,
      destination: ChainName,
      expectedBigResult = true,
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

    await testCollateral(evmHypNative, Chains.arbitrum);
    await testCollateral(evmHypNative, Chains.neutron, false);
    await testCollateral(evmHypNative, Chains.solana);
    await testCollateral(cwHypCollateral, Chains.arbitrum);

    stubs.forEach((s) => s.restore());
  });

  it('Validates transfers', async () => {
    const balanceStubs = warpCore.tokens.map((t) =>
      sinon
        .stub(t, 'getBalance')
        .returns(Promise.resolve({ amount: MOCK_BALANCE } as any)),
    );
    const quoteStubs = warpCore.tokens.map((t) =>
      sinon.stub(t, 'getHypAdapter').returns({
        quoteTransferRemoteGas: () => Promise.resolve(MOCK_INTERCHAIN_QUOTE),
        isApproveRequired: () => Promise.resolve(false),
        populateTransferRemoteTx: () => Promise.resolve({}),
      } as any),
    );

    const validResult = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(TRANSFER_AMOUNT),
      destination: Chains.arbitrum,
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
      destination: Chains.neutron,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(Object.keys(invalidRecipient || {})[0]).to.equal('recipient');

    const invalidAmount = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(-10),
      destination: Chains.arbitrum,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(Object.keys(invalidAmount || {})[0]).to.equal('amount');

    const insufficientBalance = await warpCore.validateTransfer({
      originTokenAmount: evmHypNative.amount(BIG_TRANSFER_AMOUNT),
      destination: Chains.arbitrum,
      recipient: MOCK_ADDRESS,
      sender: MOCK_ADDRESS,
    });
    expect(Object.keys(insufficientBalance || {})[0]).to.equal('amount');

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

    await testGetTxs(evmHypNative, Chains.arbitrum);
    await testGetTxs(evmHypNative, Chains.neutron);
    await testGetTxs(evmHypNative, Chains.solana);
    await testGetTxs(evmHypSynthetic, Chains.ethereum);
    await testGetTxs(
      sealevelHypSynthetic,
      Chains.ethereum,
      ProviderType.SolanaWeb3,
    );
    await testGetTxs(cwHypCollateral, Chains.arbitrum, ProviderType.CosmJsWasm);
    await testGetTxs(cosmosIbc, Chains.arbitrum, ProviderType.CosmJs);

    coreStub.restore();
    adapterStubs.forEach((s) => s.restore());
  });
});
