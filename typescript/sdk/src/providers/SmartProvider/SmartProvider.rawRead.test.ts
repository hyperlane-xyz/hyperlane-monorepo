import { expect } from 'chai';
import sinon from 'sinon';

import { ProviderMethod } from './ProviderMethods.js';
import { HyperlaneSmartProvider } from './SmartProvider.js';

// Raw signed payloads must retain their encoding and use only configured RPCs.
describe('HyperlaneSmartProvider raw reads', () => {
  afterEach(() => sinon.restore());

  function provider() {
    return new HyperlaneSmartProvider(
      { chainId: 5124, name: 'seismic' },
      [{ http: 'https://first.example' }, { http: 'https://second.example' }],
      [
        {
          name: 'explorer',
          url: 'https://explorer.example',
          apiUrl: 'https://explorer.example/api',
          apiKey: 'test',
        },
      ],
    );
  }

  it('does not advertise a general JSON-RPC send method', () => {
    expect('send' in provider()).to.equal(false);
  });

  it('preserves raw parameters and falls back only through RPC providers', async () => {
    const smart = provider();
    const explorer = sinon.stub(smart.explorerProviders[0], 'perform');
    const first = sinon
      .stub(smart.rpcProviders[0], 'send')
      .rejects(new Error('unavailable'));
    const second = sinon.stub(smart.rpcProviders[1], 'send').resolves('0x1234');
    const params = [
      {
        data: { message: { signedRead: true, nonce: '7' } },
        signature: { r: '0x01', s: '0x02' },
      },
      'latest',
    ];
    expect(await smart.sendReadRpc('eth_call', params)).to.equal('0x1234');
    expect(first.firstCall.args).to.deep.equal(['eth_call', params]);
    expect(second.firstCall.args).to.deep.equal(['eth_call', params]);
    expect(explorer.called).to.equal(false);
  });

  for (const code of [-32000, -32005]) {
    it(`falls through rate-limit code ${code} without classifying it as a revert`, async () => {
      const smart = provider();
      sinon.stub(smart.rpcProviders[0], 'send').rejects(
        Object.assign(new Error('processing response error'), {
          code: 'SERVER_ERROR',
          error: { code, message: 'rate limit exceeded', data: '0x1234' },
        }),
      );
      const second = sinon
        .stub(smart.rpcProviders[1], 'send')
        .resolves('0x1234');
      expect(
        await smart.sendReadRpc('eth_call', [{ data: '0xab' }, 'latest']),
      ).to.equal('0x1234');
      expect(second.calledOnce).to.equal(true);
    });
  }

  it('rejects writes and unknown methods before contacting any RPC', async () => {
    const smart = provider();
    const calls = smart.rpcProviders.map((rpc) => sinon.stub(rpc, 'send'));
    for (const method of [
      'eth_sendRawTransaction',
      'eth_sendTransaction',
      'wallet_sendCalls',
      'unknown',
    ]) {
      try {
        await smart.sendReadRpc(method, []);
        expect.fail('Expected unsupported RPC method');
      } catch (error) {
        expect(String(error)).to.contain('Unsupported read RPC method');
      }
    }
    expect(calls.every((call) => !call.called)).to.equal(true);
  });

  it('also rejects writes through the low-level raw-read perform path', async () => {
    const smart = provider();
    const rpc = smart.rpcProviders[0];
    const send = sinon.stub(rpc, 'send');
    try {
      await rpc.perform(ProviderMethod.ReadRpc, {
        method: 'eth_sendRawTransaction',
        params: ['0x1234'],
      });
      expect.fail('Expected unsupported RPC method');
    } catch (error) {
      expect(String(error)).to.contain('Unsupported read RPC method');
    }
    expect(send.called).to.equal(false);
  });
});
