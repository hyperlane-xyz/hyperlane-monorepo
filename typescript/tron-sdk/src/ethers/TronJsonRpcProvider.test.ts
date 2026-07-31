import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { TronWeb } from 'tronweb';

import { toTronHex } from '../utils/index.js';
import { TronJsonRpcProvider } from './TronJsonRpcProvider.js';

chai.use(chaiAsPromised);

interface CapturedRequest {
  url: string;
  payload: Record<string, unknown>;
  method?: string;
}

interface ConstantCallResponse {
  result: { result: boolean; message?: string };
  constant_result: string[];
}

function stubFullNode(
  provider: TronJsonRpcProvider,
  response: ConstantCallResponse,
  captured?: { value?: CapturedRequest },
): void {
  const tronWeb = {
    fullNode: {
      request: async (
        url: string,
        payload: Record<string, unknown>,
        method?: string,
      ) => {
        if (captured) {
          captured.value = { url, payload, method };
        }
        return response;
      },
    },
  } as unknown as TronWeb;
  (provider as unknown as { tronWeb: TronWeb }).tronWeb = tronWeb;
}

describe('TronJsonRpcProvider', () => {
  it('routes contract reads through the raw constant-call endpoint and returns the decoded data', async () => {
    const provider = new TronJsonRpcProvider(
      'https://node.example.com/jsonrpc',
      728126428,
      1,
      0,
    );
    const captured: { value?: CapturedRequest } = {};
    stubFullNode(
      provider,
      { result: { result: true }, constant_result: ['00ff'] },
      captured,
    );

    const result = await provider.call({
      to: '0x19335987d77120c462ca7df51cf29f68a38e6d6c',
      data: '0x7f5a7c7b',
    });

    expect(result).to.equal('0x00ff');
    expect(captured.value?.url).to.equal('wallet/triggerconstantcontract');
    expect(captured.value?.method).to.equal('post');
    expect(captured.value?.payload.contract_address).to.equal(
      '4119335987d77120c462ca7df51cf29f68a38e6d6c',
    );
    expect(captured.value?.payload.data).to.equal('7f5a7c7b');
  });

  it('returns 0x for a reverted/missing-selector constant call without throwing', async () => {
    const provider = new TronJsonRpcProvider(
      'https://node.example.com/jsonrpc',
      728126428,
      1,
      0,
    );
    stubFullNode(provider, {
      result: { result: false, message: 'REVERT opcode executed' },
      constant_result: [],
    });

    const result = await provider.call({
      to: '0x19335987d77120c462ca7df51cf29f68a38e6d6c',
      data: '0x7f5a7c7b',
    });

    expect(result).to.equal('0x');
  });
});

describe('toTronHex', () => {
  const tronWeb = new TronWeb({ fullHost: 'https://api.trongrid.io' });

  it('resolves base58 addresses through TronWeb', () => {
    expect(toTronHex(tronWeb, 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb')).to.equal(
      '410000000000000000000000000000000000000000',
    );
  });

  it('passes through already-41-prefixed hex', () => {
    expect(
      toTronHex(tronWeb, '4119335987d77120c462ca7df51cf29f68a38e6d6c'),
    ).to.equal('4119335987d77120c462ca7df51cf29f68a38e6d6c');
  });

  it('prefixes 0x hex with the Tron 41 byte', () => {
    expect(
      toTronHex(tronWeb, '0x19335987d77120c462ca7df51cf29f68a38e6d6c'),
    ).to.equal('4119335987d77120c462ca7df51cf29f68a38e6d6c');
  });
});
