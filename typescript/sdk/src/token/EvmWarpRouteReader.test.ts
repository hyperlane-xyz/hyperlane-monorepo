import { BigNumber } from 'ethers';
import { expect } from 'chai';
import sinon from 'sinon';

import {
  IMessageTransmitter__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';

import { TestChainName } from '../consts/testChains.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { randomAddress } from '../test/testUtils.js';

import {
  CCTP_PPM_PRECISION_VERSION,
  EvmWarpRouteReader,
  TOKEN_FEE_CONTRACT_VERSION,
} from './EvmWarpRouteReader.js';
import { TokenType } from './config.js';

describe('EvmWarpRouteReader', () => {
  let sandbox: sinon.SinonSandbox;
  let evmWarpRouteReader: EvmWarpRouteReader;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    evmWarpRouteReader = new EvmWarpRouteReader(
      MultiProvider.createTestMultiProvider(),
      TestChainName.test1,
    );
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('retries token router domains when a shared domains promise fails', async () => {
    const routerAddress = randomAddress();
    const feeRecipient = randomAddress();
    const routingDestinations = [1, 2];
    const derivedTokenFeeConfig = { address: feeRecipient } as any;
    const domains = sandbox.stub().resolves(routingDestinations);

    sandbox.stub(TokenRouter__factory, 'connect').returns({
      feeRecipient: sandbox.stub().resolves(feeRecipient),
      domains,
    } as any);
    sandbox
      .stub(evmWarpRouteReader, 'fetchPackageVersion')
      .resolves(TOKEN_FEE_CONTRACT_VERSION);
    const deriveTokenFeeConfigStub = sandbox
      .stub(evmWarpRouteReader.evmTokenFeeReader, 'deriveTokenFeeConfig')
      .resolves(derivedTokenFeeConfig);

    const tokenFee = await evmWarpRouteReader.fetchTokenFee(
      routerAddress,
      undefined,
      () => Promise.reject(new Error('transient domains failure')),
    );

    expect(tokenFee).to.equal(derivedTokenFeeConfig);
    expect(domains.calledOnce).to.equal(true);
    expect(
      deriveTokenFeeConfigStub.calledOnceWithExactly({
        address: feeRecipient,
        routingDestinations,
      }),
    ).to.equal(true);
  });

  it('does not start shared domains reads when token fee derivation returns early', async () => {
    const routerAddress = randomAddress();
    let getDestinationsCalls = 0;

    sandbox.stub(TokenRouter__factory, 'connect').returns({
      feeRecipient: sandbox.stub().resolves(randomAddress()),
      domains: sandbox.stub().resolves([1, 2]),
    } as any);
    sandbox.stub(evmWarpRouteReader, 'fetchPackageVersion').resolves('9.9.9');

    const tokenFee = await evmWarpRouteReader.fetchTokenFee(
      routerAddress,
      undefined,
      () => {
        getDestinationsCalls += 1;
        return Promise.resolve([1, 2]);
      },
    );

    expect(tokenFee).to.be.undefined;
    expect(getDestinationsCalls).to.equal(0);
  });

  it('decodes uint batch results before deriving cross-collateral config', async () => {
    const routerAddress = randomAddress();
    const wrappedTokenAddress = randomAddress();
    const localDomain = 31337;
    const remoteDomain = 31338;
    const localRouter = randomAddress();
    const remoteRouter = randomAddress();
    const expectedScale = { numerator: 1n, denominator: 1n };

    const batchStub = sandbox.stub(
      evmWarpRouteReader as any,
      'readContractBatch',
    );
    batchStub
      .onFirstCall()
      .callsFake(async (calls: any[]) => [
        wrappedTokenAddress,
        calls[1].decode([[BigNumber.from(remoteDomain)]]),
        calls[2].decode([
          [BigNumber.from(localDomain), BigNumber.from(remoteDomain)],
        ]),
        calls[3].decode([BigNumber.from(localDomain)]),
      ]);
    batchStub.onSecondCall().callsFake(async (calls: any[]) => {
      expect(calls.map((call) => call.args?.[0])).to.deep.equal([
        remoteDomain,
        localDomain,
      ]);
      return [[remoteRouter], [localRouter]];
    });
    sandbox.stub(evmWarpRouteReader, 'fetchERC20Metadata').resolves({
      name: 'Token',
      symbol: 'TKN',
      decimals: 18,
      isNft: false,
    });
    sandbox.stub(evmWarpRouteReader, 'fetchScale').resolves(expectedScale);

    const deriveCrossCollateralTokenConfig = (evmWarpRouteReader as any)
      .deriveCrossCollateralTokenConfig as (address: string) => Promise<any>;
    const derivedConfig = await deriveCrossCollateralTokenConfig.call(
      evmWarpRouteReader,
      routerAddress,
    );

    expect(derivedConfig.type).to.equal(TokenType.crossCollateral);
    expect(derivedConfig.token).to.equal(wrappedTokenAddress);
    expect(derivedConfig.scale).to.deep.equal(expectedScale);
    expect(derivedConfig.crossCollateralRouters).to.deep.equal({
      [remoteDomain.toString()]: [remoteRouter],
      [localDomain.toString()]: [localRouter],
    });
  });

  it('decodes minFinalityThreshold to a number for CCTP V2 batched reads', async () => {
    const hypToken = randomAddress();
    const messageTransmitter = randomAddress();
    const tokenMessenger = randomAddress();
    const urls = ['https://example.com'];

    sandbox
      .stub(evmWarpRouteReader as any, 'deriveHypCollateralTokenConfig')
      .resolves({
        type: TokenType.collateral,
        token: randomAddress(),
        name: 'Token',
        symbol: 'TKN',
        decimals: 6,
        isNft: false,
      });
    const batchStub = sandbox.stub(
      evmWarpRouteReader as any,
      'readContractBatch',
    );
    batchStub
      .onFirstCall()
      .resolves([messageTransmitter, tokenMessenger, urls]);
    batchStub
      .onSecondCall()
      .callsFake(async (calls: any[]) => [
        calls[0].decode([BigNumber.from(1000)]),
        calls[1].decode([BigNumber.from(123)]),
      ]);
    sandbox.stub(IMessageTransmitter__factory, 'connect').returns({
      version: sandbox.stub().resolves(1),
    } as any);
    sandbox
      .stub(evmWarpRouteReader, 'fetchPackageVersion')
      .resolves(CCTP_PPM_PRECISION_VERSION);

    const deriveHypCollateralCctpTokenConfig = (evmWarpRouteReader as any)
      .deriveHypCollateralCctpTokenConfig as (address: string) => Promise<any>;
    const derivedConfig = await deriveHypCollateralCctpTokenConfig.call(
      evmWarpRouteReader,
      hypToken,
    );

    expect(derivedConfig.type).to.equal(TokenType.collateralCctp);
    expect(derivedConfig.cctpVersion).to.equal('V2');
    expect(derivedConfig.minFinalityThreshold).to.equal(1000);
    expect(derivedConfig.minFinalityThreshold).to.be.a('number');
    expect(derivedConfig.maxFeeBps).to.equal(123);
  });
});
