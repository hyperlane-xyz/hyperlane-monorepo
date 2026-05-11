import { expect } from 'chai';
import sinon from 'sinon';

import { StargateClient } from '@cosmjs/stargate';

import { ProviderType } from './ProviderType.js';
import {
  clearCachedStargateClients,
  estimateTransactionFeeCosmJsWasm,
} from './transactionFeeEstimators.js';

describe('transactionFeeEstimators', () => {
  const sender = 'cosmos1sender';
  const senderPubKey = `02${'aa'.repeat(32)}`;
  const transaction = {
    type: ProviderType.CosmJsWasm,
    transaction: {
      contractAddress: 'cosmos1contract',
      msg: {},
      funds: [],
    },
  } as any;

  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
  });

  afterEach(() => {
    clearCachedStargateClients();
    sandbox.restore();
  });

  function makeProvider(url: string) {
    return {
      type: ProviderType.CosmJsWasm,
      provider: Promise.resolve({
        cometClient: {
          client: {
            url,
          },
        },
      }),
    } as any;
  }

  function makeStargateClient(
    simulate: sinon.SinonStub,
  ): StargateClient & { disconnect: sinon.SinonStub } {
    return {
      disconnect: sandbox.stub(),
      getSequence: sandbox.stub().resolves({ sequence: 1 }),
      forceGetQueryClient: sandbox.stub().returns({
        tx: {
          simulate,
        },
      }),
    } as unknown as StargateClient & { disconnect: sinon.SinonStub };
  }

  async function estimate(url: string) {
    return estimateTransactionFeeCosmJsWasm({
      transaction,
      provider: makeProvider(url),
      estimatedGasPrice: '2',
      sender,
      senderPubKey,
    });
  }

  it('reuses cached Stargate clients for HTTP URLs', async () => {
    const simulate = sandbox.stub().resolves({ gasInfo: { gasUsed: 10 } });
    const client = makeStargateClient(simulate);
    const connect = sandbox.stub(StargateClient, 'connect').resolves(client);

    await estimate('https://cosmos-rpc.example');
    await estimate('https://cosmos-rpc.example');

    expect(
      connect.calledOnceWithExactly('https://cosmos-rpc.example'),
    ).to.equal(true);
    expect(simulate.calledTwice).to.equal(true);
  });

  it('evicts cached Stargate clients when simulation fails', async () => {
    const firstClient = makeStargateClient(
      sandbox.stub().rejects(new Error('socket has disconnected')),
    );
    const secondClient = makeStargateClient(
      sandbox.stub().resolves({ gasInfo: { gasUsed: 10 } }),
    );
    const connect = sandbox
      .stub(StargateClient, 'connect')
      .onFirstCall()
      .resolves(firstClient)
      .onSecondCall()
      .resolves(secondClient);

    try {
      await estimate('https://cosmos-rpc.example');
      throw new Error('Expected estimate to fail');
    } catch (error) {
      expect((error as Error).message).to.equal('socket has disconnected');
    }
    await estimate('https://cosmos-rpc.example');

    expect(connect.calledTwice).to.equal(true);
    expect(firstClient.disconnect.calledOnce).to.equal(true);
  });

  it('does not cache Stargate clients for WebSocket URLs', async () => {
    const firstClient = makeStargateClient(
      sandbox.stub().resolves({ gasInfo: { gasUsed: 10 } }),
    );
    const secondClient = makeStargateClient(
      sandbox.stub().resolves({ gasInfo: { gasUsed: 10 } }),
    );
    const connect = sandbox
      .stub(StargateClient, 'connect')
      .onFirstCall()
      .resolves(firstClient)
      .onSecondCall()
      .resolves(secondClient);

    await estimate('wss://cosmos-rpc.example');
    await estimate('wss://cosmos-rpc.example');

    expect(connect.calledTwice).to.equal(true);
    expect(firstClient.disconnect.calledOnce).to.equal(true);
    expect(secondClient.disconnect.calledOnce).to.equal(true);
  });
});
