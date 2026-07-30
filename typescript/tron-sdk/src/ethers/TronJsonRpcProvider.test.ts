import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { TronWeb } from 'tronweb';

import { toTronHex } from '../utils/index.js';
import { TronJsonRpcProvider } from './TronJsonRpcProvider.js';

chai.use(chaiAsPromised);

interface CapturedCall {
  contractAddress: string;
  options: { callValue: number; input?: string };
}

describe('TronJsonRpcProvider', () => {
  it('uses triggerConstantContract for latest contract calls', async () => {
    const provider = new TronJsonRpcProvider(
      'https://node.example.com/jsonrpc',
      728126428,
    );
    let captured: CapturedCall | undefined;
    const tronWeb = {
      transactionBuilder: {
        triggerConstantContract: async (
          contractAddress: string,
          _selector: string,
          options: { callValue: number; input?: string },
        ) => {
          captured = { contractAddress, options };
          return {
            result: { result: true },
            constant_result: ['00ff'],
          };
        },
      },
    } as unknown as TronWeb;
    (provider as unknown as { tronWeb: TronWeb }).tronWeb = tronWeb;

    const result = await provider.call({
      to: '0x19335987d77120c462ca7df51cf29f68a38e6d6c',
      data: '0x7f5a7c7b',
    });

    expect(result).to.equal('0x00ff');
    expect(captured?.contractAddress).to.equal(
      '4119335987d77120c462ca7df51cf29f68a38e6d6c',
    );
    expect(captured?.options.input).to.equal('7f5a7c7b');
  });

  it('rejects when Tron reports the constant call as failed', async () => {
    const provider = new TronJsonRpcProvider(
      'https://node.example.com/jsonrpc',
      728126428,
    );
    const tronWeb = {
      transactionBuilder: {
        triggerConstantContract: async () => ({
          result: { result: false, message: 'REVERT opcode executed' },
        }),
      },
    } as unknown as TronWeb;
    (provider as unknown as { tronWeb: TronWeb }).tronWeb = tronWeb;

    await expect(
      provider.call({
        to: '0x19335987d77120c462ca7df51cf29f68a38e6d6c',
        data: '0x7f5a7c7b',
      }),
    ).to.be.rejectedWith(/Tron constant call failed: REVERT opcode executed/);
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
