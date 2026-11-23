import { expect } from 'chai';
import { rejects } from 'node:assert/strict';
import sinon from 'sinon';
import { RpcProvider } from 'starknet';

import { MultiProviderAdapter } from '../../providers/MultiProviderAdapter.js';
import { TokenMetadataSchema } from '../types.js';

import { StarknetHypSyntheticAdapter } from './StarknetTokenAdapter.js';

describe('StarknetHypTokenAdapter Cairo response normalization', () => {
  // Stub raw felt responses at the RPC boundary, retaining the generated
  // HypErc20 ABI and starknet.js Contract response decoder.
  function setup(responses: Record<string, string[]>) {
    const provider = new RpcProvider({
      nodeUrl: 'http://127.0.0.1:1',
      specVersion: '0.8.1',
    });
    sinon.stub(provider, 'callContract').callsFake(async ({ entrypoint }) => {
      const response = responses[entrypoint];
      if (!response) throw new Error(`Unexpected entrypoint ${entrypoint}`);
      return response;
    });
    const multiProvider = sinon.createStubInstance(MultiProviderAdapter);
    multiProvider.getStarknetProvider.returns(provider);
    return new StarknetHypSyntheticAdapter('starknet', multiProvider, {
      warpRouter: '0x123',
    });
  }

  it('returns token decimals as a number accepted by the metadata schema', async () => {
    const adapter = setup({
      decimals: ['0x12'],
      // Cairo ByteArray: no full words, one pending word, four bytes.
      symbol: ['0x0', '0x54455354', '0x4'],
      name: ['0x0', '0x54455354', '0x4'],
    });

    const metadata = await adapter.getMetadata();
    expect(metadata).to.deep.equal({
      decimals: 18,
      symbol: 'TEST',
      name: 'TEST',
    });
    expect(TokenMetadataSchema.parse(metadata)).to.deep.equal(metadata);
  });

  it('returns numeric uint32 domains in the on-chain order', async () => {
    const adapter = setup({ domains: ['0x3', '0xffffffff', '0x0', '0x1'] });
    expect(await adapter.getDomains()).to.deep.equal([4294967295, 0, 1]);
  });

  it('rejects out-of-range decoded domains instead of rounding or accepting them', async () => {
    const adapter = setup({ domains: ['0x1', '0x100000000'] });
    await rejects(adapter.getDomains(), (error: unknown) => {
      expect(String(error)).to.include('Value must fit in a uint32');
      return true;
    });
  });

  for (const { label, low, high, expected } of [
    {
      label: 'leading zero bytes',
      low: '0x1234',
      high: '0x0',
      expected: '00'.repeat(30) + '1234',
    },
    {
      label: 'both uint128 limbs',
      low: '0x11',
      high: '0x2233',
      expected: '2233'.padStart(32, '0') + '11'.padStart(32, '0'),
    },
    {
      label: 'the full uint256 range',
      low: '0xffffffffffffffffffffffffffffffff',
      high: '0xffffffffffffffffffffffffffffffff',
      expected: 'ff'.repeat(32),
    },
    {
      label: 'an unenrolled zero router',
      low: '0x0',
      high: '0x0',
      expected: '00'.repeat(32),
    },
  ]) {
    it(`returns a 32-byte big-endian router preserving ${label}`, async () => {
      const adapter = setup({ routers: [low, high] });
      const router = await adapter.getRouterAddress(1);
      expect(router).to.be.instanceOf(Buffer);
      expect(router.length).to.equal(32);
      expect(router.toString('hex')).to.equal(expected);
    });
  }

  it('enumerates routes with numeric domains and byte-buffer addresses', async () => {
    const adapter = setup({
      domains: ['0x2', '0x1', '0x2'],
      routers: ['0x1234', '0x0'],
    });
    const expectedAddress = Buffer.from('00'.repeat(30) + '1234', 'hex');
    expect(await adapter.getAllRouters()).to.deep.equal([
      { domain: 1, address: expectedAddress },
      { domain: 2, address: expectedAddress },
    ]);
  });
});
