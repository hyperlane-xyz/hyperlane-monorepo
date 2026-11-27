import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { BigNumber } from 'ethers';
import sinon from 'sinon';

import {
  Address,
  ProtocolType,
  bytes32ToAddress,
  formatStandardHookMetadata,
} from '@hyperlane-xyz/utils';

import { TestChainName } from '../../../consts/testChains.js';
import { MultiProvider } from '../../MultiProvider.js';
import { randomAddress } from '../../../test/testUtils.js';

import {
  EvmIcaTxSubmitter,
  ICA_QUOTE_BUFFER_MULTIPLIER,
} from './IcaTxSubmitter.js';
import { TxSubmitterType } from './TxSubmitterTypes.js';
import { EvmIcaTxSubmitterProps } from './ethersV5/types.js';
import { getSubmitter } from './submitterBuilderGetter.js';
import { SubmitterMetadata } from './types.js';

chai.use(chaiAsPromised);

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

  it('encodes the configured refundAddress into hookMetadata instead of the owner', async () => {
    const estimatedGas = BigNumber.from(150_000);
    mockApp.estimateIcaHandleGas.resolves(estimatedGas);
    mockApp.getCallRemote.resolves({
      to: randomAddress(),
      data: '0x',
      value: undefined,
    });
    const refundAddress = '0x00000000000000000000000000000000000000AA';

    const { chainId: destChainId } =
      multiProvider.getChainMetadata(destination);
    await makeSubmitter({ refundAddress }).submit({
      to: randomAddress(),
      data: '0x1234',
      chainId: destChainId,
    });

    expect(mockApp.getCallRemote.firstCall.args[0].hookMetadata).to.equal(
      formatStandardHookMetadata({
        refundAddress,
        gasLimit: estimatedGas.toBigInt(),
      }),
    );
    // callRemote must still be sent by the owner
    expect(mockSubmitter.submit.firstCall.args[0].from).to.equal(
      bytes32ToAddress(owner),
    );
  });

  it('forwards the callRemote tx to the inner submitter with `from` set to the ICA owner', async () => {
    mockApp.estimateIcaHandleGas.resolves(BigNumber.from(150_000));
    // Simulate getCallRemote populating `from` with the signer (deployer) address;
    // the submitter must override it with the configured owner.
    const deployer = randomAddress();
    mockApp.getCallRemote.resolves({
      to: randomAddress(),
      data: '0x',
      value: undefined,
      from: deployer,
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

    expect(mockSubmitter.submit.calledOnce).to.be.true;
    const forwarded = mockSubmitter.submit.firstCall.args[0];
    expect(forwarded.from).to.equal(bytes32ToAddress(owner));
    expect(forwarded.from).to.not.equal(deployer);
  });

  it('buffers the IGP quote `value` on the forwarded callRemote tx', async () => {
    mockApp.estimateIcaHandleGas.resolves(BigNumber.from(150_000));
    // Realistic path: getCallRemote attaches the IGP quote as the tx value.
    const quote = BigNumber.from('123456789');
    mockApp.getCallRemote.resolves({
      to: randomAddress(),
      data: '0x',
      value: quote,
    });

    const { chainId: destChainId } =
      multiProvider.getChainMetadata(destination);
    const tx = {
      to: randomAddress(),
      data: '0x1234',
      chainId: destChainId,
    };

    await makeSubmitter().submit(tx);

    const forwarded = mockSubmitter.submit.firstCall.args[0];
    expect(
      BigNumber.from(forwarded.value).eq(
        quote.mul(ICA_QUOTE_BUFFER_MULTIPLIER),
      ),
    ).to.be.true;
    // The `from` override must not clobber other populated fields.
    expect(forwarded.from).to.equal(bytes32ToAddress(owner));
  });
});

describe('EvmIcaTxSubmitter.fromConfig with an AccessManager internal submitter', () => {
  const origin = TestChainName.test1;
  const destination = TestChainName.test2;
  const accessManagerAddress: Address =
    '0x3D079E977d644c914a344Dcb5Ba54dB243Cc4863';
  const refundAddress: Address = '0x00000000000000000000000000000000000000AA';
  const HASH_16_BYTES_MOCK: Address = '0x12345678901234567890123456789012';
  const originRouter = randomAddress();

  function buildIcaConfig(fields: {
    owner: Address;
    refundAddress?: Address;
  }): EvmIcaTxSubmitterProps {
    return {
      type: TxSubmitterType.INTERCHAIN_ACCOUNT,
      chain: origin,
      destinationChain: destination,
      owner: fields.owner,
      refundAddress: fields.refundAddress,
      originInterchainAccountRouter: originRouter,
      internalSubmitter: {
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: origin,
        accessManagerAddress,
        proposerSubmitter: { type: TxSubmitterType.JSON_RPC, chain: origin },
      },
    };
  }

  const missingRefundMessage = `Interchain account on ${origin} owned by AccessManager ${accessManagerAddress} requires a refundAddress other than the AccessManager`;

  const cases: Array<{
    name: string;
    metadata: SubmitterMetadata;
    expectedError: string;
  }> = [
    {
      name: 'the refundAddress is missing',
      metadata: buildIcaConfig({ owner: accessManagerAddress }),
      expectedError: missingRefundMessage,
    },
    {
      name: 'the refundAddress is the AccessManager',
      metadata: buildIcaConfig({
        owner: accessManagerAddress,
        refundAddress: accessManagerAddress.toLowerCase(),
      }),
      expectedError: missingRefundMessage,
    },
    {
      name: 'the owner is not the AccessManager',
      metadata: buildIcaConfig({ owner: randomAddress(), refundAddress }),
      expectedError: `must be AccessManager ${accessManagerAddress}`,
    },
    {
      name: 'the refundAddress is a 16-byte value',
      metadata: buildIcaConfig({
        owner: accessManagerAddress,
        refundAddress: HASH_16_BYTES_MOCK,
      }),
      expectedError: `Interchain account refundAddress ${HASH_16_BYTES_MOCK} on ${origin} must be a valid EVM address`,
    },
    {
      name: 'the refundAddress is missing on an interchain account nested as an AccessManager proposer',
      metadata: {
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: destination,
        accessManagerAddress: randomAddress(),
        proposerSubmitter: buildIcaConfig({ owner: accessManagerAddress }),
      },
      expectedError: missingRefundMessage,
    },
  ];

  for (const { name, metadata, expectedError } of cases) {
    it(`should reject the config when ${name}`, async () => {
      await expect(
        getSubmitter<ProtocolType.Ethereum>(
          MultiProvider.createTestMultiProvider(),
          metadata,
          {},
        ),
      ).to.be.rejectedWith(expectedError);
    });
  }

  it('should accept a refundAddress with a bad EIP-55 checksum', async () => {
    // Mixed-case casing of 0x32e02dDB233958834fcB5E93b11E254F8D1EAd1b with a wrong checksum
    const badChecksumRefundAddress: Address =
      '0x32E02dDB233958834fcB5E93b11E254F8D1EAd1b';

    // The registry router matching originInterchainAccountRouter avoids
    // reading remote routers on-chain
    const submitter = await getSubmitter<ProtocolType.Ethereum>(
      MultiProvider.createTestMultiProvider(),
      buildIcaConfig({
        owner: accessManagerAddress,
        refundAddress: badChecksumRefundAddress,
      }),
      { [origin]: { interchainAccountRouter: originRouter } },
    );

    expect(submitter.txSubmitterType).to.equal(
      TxSubmitterType.INTERCHAIN_ACCOUNT,
    );
  });
});
