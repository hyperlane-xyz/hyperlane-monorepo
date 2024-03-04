import { expect } from 'chai';
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import sinon from 'sinon';
import { parse as yamlParse } from 'yaml';

import { chainMetadata } from '../consts/chainMetadata';
import { Chains } from '../consts/chains';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';
import { ProviderType } from '../providers/ProviderType';
import { Token } from '../token/Token';
import { TokenStandard } from '../token/TokenStandard';
import { InterchainFeeQuote } from '../token/adapters/ITokenAdapter';
import { ChainName } from '../types';

import { WarpCore } from './WarpCore';
import { WarpTxCategory } from './types';

const MOCK_QUOTE = { amount: 20_000n };
const TRANSFER_AMOUNT = BigInt('1000000000000000000'); // 1 units @ 18 decimals
const BIG_TRANSFER_AMOUNT = BigInt('100000000000000000000'); // 100 units @ 18 decimals
const MOCK_BALANCE = BigInt('10000000000000000000'); // 10 units @ 18 decimals

describe('WarpCore', () => {
  const multiProvider = new MultiProtocolProvider();
  let warpCore: WarpCore;
  let evmHypNative: Token;
  let evmHypSynthetic: Token;
  let sealevelHypSynthetic: Token;
  let cwHypCollateral: Token;
  let cw20: Token;
  let cosmosIbc: Token;

  it('Constructs', () => {
    const fromArgs = new WarpCore(multiProvider, [
      Token.FromChainMetadataNativeToken(chainMetadata[Chains.ethereum]),
    ]);
    const exampleConfig = yamlParse(
      fs.readFileSync(
        path.join(__dirname, './example-warp-core-config.yaml'),
        'utf-8',
      ),
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
        quoteGasPayment: () => Promise.resolve(MOCK_QUOTE),
      } as any),
    );

    const testQuote = async (
      token: Token,
      chain: ChainName,
      standard: TokenStandard,
      quote: InterchainFeeQuote = MOCK_QUOTE,
    ) => {
      const result = await warpCore.getInterchainTransferFee(token, chain);
      expect(
        result.token.standard,
        `token standard check for ${token.chainName} to ${chain}`,
      ).equals(standard);
      expect(
        result.amount,
        `token amount check for ${token.chainName} to ${chain}`,
      ).to.equal(quote.amount);
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
      chain: ChainName,
      expectedBigResult = true,
    ) => {
      const smallResult = await warpCore.isDestinationCollateralSufficient(
        token.amount(TRANSFER_AMOUNT),
        chain,
      );
      expect(
        smallResult,
        `small collateral check for ${token.chainName} to ${chain}`,
      ).to.be.true;
      const bigResult = await warpCore.isDestinationCollateralSufficient(
        token.amount(BIG_TRANSFER_AMOUNT),
        chain,
      );
      expect(
        bigResult,
        `big collateral check for ${token.chainName} to ${chain}`,
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
        quoteGasPayment: () => Promise.resolve(MOCK_QUOTE),
      } as any),
    );

    const validResult = await warpCore.validateTransfer(
      evmHypNative.amount(TRANSFER_AMOUNT),
      Chains.arbitrum,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
    );
    expect(validResult).to.be.null;

    const invalidChain = await warpCore.validateTransfer(
      evmHypNative.amount(TRANSFER_AMOUNT),
      'fakechain',
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
    );
    expect(Object.keys(invalidChain || {})[0]).to.equal('destination');

    const invalidRecipient = await warpCore.validateTransfer(
      evmHypNative.amount(TRANSFER_AMOUNT),
      Chains.neutron,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
    );
    expect(Object.keys(invalidRecipient || {})[0]).to.equal('recipient');

    const invalidAmount = await warpCore.validateTransfer(
      evmHypNative.amount(-10),
      Chains.arbitrum,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
    );
    expect(Object.keys(invalidAmount || {})[0]).to.equal('amount');

    const insufficientBalance = await warpCore.validateTransfer(
      evmHypNative.amount(BIG_TRANSFER_AMOUNT),
      Chains.arbitrum,
      ethers.constants.AddressZero,
      ethers.constants.AddressZero,
    );
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
        quoteGasPayment: () => Promise.resolve(MOCK_QUOTE),
        populateTransferRemoteTx: () => Promise.resolve({}),
      } as any),
    );

    const testGetTxs = async (
      token: Token,
      chain: ChainName,
      providerType = ProviderType.EthersV5,
    ) => {
      const result = await warpCore.getTransferRemoteTxs(
        token.amount(TRANSFER_AMOUNT),
        chain,
        ethers.constants.AddressZero,
        ethers.constants.AddressZero,
      );
      expect(result.length).to.equal(1);
      expect(
        result[0],
        `transfer tx for ${token.chainName} to ${chain}`,
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
