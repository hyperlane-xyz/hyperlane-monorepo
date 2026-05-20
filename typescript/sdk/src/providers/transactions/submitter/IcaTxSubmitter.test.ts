import { expect } from 'chai';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import {
  bytes32ToAddress,
  formatStandardHookMetadata,
} from '@hyperlane-xyz/utils';

import { TestChainName } from '../../../consts/testChains.js';
import { MultiProvider } from '../../MultiProvider.js';
import { randomAddress } from '../../../test/testUtils.js';

import { EvmIcaTxSubmitter } from './IcaTxSubmitter.js';

describe('EvmIcaTxSubmitter.submit', () => {
  const origin = TestChainName.test1;
  const destination = TestChainName.test2;

  let sandbox: sinon.SinonSandbox;
  let multiProvider: MultiProvider;
  let mockApp: Record<string, sinon.SinonStub>;
  let mockSubmitter: { submit: sinon.SinonStub };

  const owner = randomAddress();
  const originRouter = randomAddress();
  const destRouter = randomAddress();

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    multiProvider = MultiProvider.createTestMultiProvider();
    mockApp = {
      estimateIcaHandleGas: sandbox.stub(),
      getCallRemote: sandbox.stub(),
    };
    mockSubmitter = { submit: sandbox.stub().resolves([]) };
  });

  afterEach(() => sandbox.restore());

  function makeSubmitter(overrides: Record<string, unknown> = {}) {
    const config = {
      chain: origin,
      owner,
      destinationChain: destination,
      originInterchainAccountRouter: originRouter,
      destinationInterchainAccountRouter: destRouter,
      ...overrides,
    };
    // EvmIcaTxSubmitter has a protected constructor; bypass for testing
    return new (EvmIcaTxSubmitter as any)(
      config,
      mockSubmitter,
      multiProvider,
      mockApp,
    );
  }

  it('encodes estimated gas into hookMetadata and passes same icaConfig to both estimate and getCallRemote', async () => {
    const estimatedGas = BigNumber.from(150_000);
    mockApp.estimateIcaHandleGas.resolves(estimatedGas);
    mockApp.getCallRemote.resolves({
      to: randomAddress(),
      data: '0x',
      value: undefined,
    });

    const { chainId: destChainId } =
      multiProvider.getChainMetadata(destination);
    const tx = {
      to: randomAddress(),
      data: '0x1234',
      chainId: destChainId,
    };

    const submitter = makeSubmitter();
    await submitter.submit(tx);

    const expectedIcaConfig = {
      origin,
      owner,
      ismOverride: undefined,
      routerOverride: destRouter,
      localRouter: originRouter,
    };

    // Both methods receive the same icaConfig
    expect(mockApp.estimateIcaHandleGas.calledOnce).to.be.true;
    expect(mockApp.estimateIcaHandleGas.firstCall.args[0].config).to.deep.equal(
      expectedIcaConfig,
    );

    expect(mockApp.getCallRemote.calledOnce).to.be.true;
    expect(mockApp.getCallRemote.firstCall.args[0].config).to.deep.equal(
      expectedIcaConfig,
    );

    // hookMetadata passed to getCallRemote encodes the estimated gas
    const expectedHookMetadata = formatStandardHookMetadata({
      refundAddress: bytes32ToAddress(owner),
      gasLimit: estimatedGas.toBigInt(),
    });
    expect(mockApp.getCallRemote.firstCall.args[0].hookMetadata).to.equal(
      expectedHookMetadata,
    );
  });
});
