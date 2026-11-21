import { expect } from 'chai';
import sinon from 'sinon';
import { RpcProvider } from 'starknet';

import { testStarknetChain } from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';

import { StarknetCoreAdapter } from './StarknetCoreAdapter.js';

describe('Starknet delivery reads', () => {
  const chain = testStarknetChain.name;
  const primary = 'https://primary.example';
  const alternate = 'https://alternate.example';
  const adapter = new StarknetCoreAdapter(
    chain,
    new MultiProtocolProvider({
      [chain]: {
        ...testStarknetChain,
        rpcUrls: [{ http: primary }, { http: alternate }],
      },
    }),
    { mailbox: '0x123' },
  );

  afterEach(() => sinon.restore());

  it('confirms through the next RPC when the first read fails', async () => {
    const calls: string[] = [];
    sinon
      .stub(RpcProvider.prototype, 'callContract')
      .callsFake(async function (this: RpcProvider) {
        calls.push(this.channel.nodeUrl);
        if (this.channel.nodeUrl === primary) throw new Error('Unauthorized');
        return ['0x1'];
      });
    expect(await adapter.waitForMessageProcessed('0x01', chain, 1, 1)).to.equal(
      true,
    );
    expect(calls).to.deep.equal([primary, alternate]);
  });

  it('accepts a successful pending read without querying another RPC', async () => {
    const read = sinon
      .stub(RpcProvider.prototype, 'callContract')
      .resolves(['0x0']);
    expect(await adapter.isDelivered('0x01')).to.equal(false);
    expect(read.callCount).to.equal(1);
  });
});
