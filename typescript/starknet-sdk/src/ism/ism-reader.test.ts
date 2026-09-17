import { expect } from 'chai';
import { RpcProvider } from 'starknet';

import { AltVM, ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { getContractClassHash } from '@hyperlane-xyz/starknet-core/runtime';

import { normalizeStarknetAddressSafe } from '../contracts.js';
import { StarknetIsmArtifactManager } from './ism-artifact-manager.js';
import { getIsmType } from './ism-query.js';

async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String(error);
  }
  throw new Error('Expected rejection');
}

const address = normalizeStarknetAddressSafe;
const metadata = {
  name: 'starknet',
  protocol: ProtocolType.Starknet,
  chainId: 'SN_MAIN',
  domainId: 358974494,
  rpcUrls: [{ http: 'http://localhost:9545' }],
};

describe('Starknet ISM reading', () => {
  // Saved only for restoring the prototype; never invoked without a receiver.
  // oxlint-disable-next-line typescript/unbound-method
  const originalCall = RpcProvider.prototype.callContract;
  // oxlint-disable-next-line typescript/unbound-method
  const originalClassHash = RpcProvider.prototype.getClassHashAt;
  afterEach(() => {
    RpcProvider.prototype.callContract = originalCall;
    RpcProvider.prototype.getClassHashAt = originalClassHash;
  });

  it('reads aggregation modules and threshold instead of reporting testIsm', async () => {
    RpcProvider.prototype.callContract = async (call) => {
      switch (call.entrypoint) {
        case 'module_type':
          return ['0x2', '0x1'];
        case 'get_modules':
          return ['0x2', '0x2', '0x3'];
        case 'get_threshold':
          return ['0x2'];
        default:
          throw new Error(`Unexpected call ${call.entrypoint}`);
      }
    };
    const result = await new StarknetIsmArtifactManager(metadata).readIsm(
      '0x1',
    );
    expect(result).to.deep.equal({
      artifactState: ArtifactState.DEPLOYED,
      config: {
        type: 'staticAggregationIsm',
        threshold: 2,
        modules: ['0x2', '0x3'].map((a) => ({
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: address(a) },
        })),
      },
      deployed: { address: address('0x1') },
    });
  });

  for (const paused of [false, true]) {
    it(`reads NULL pausable ISM with paused=${paused}`, async () => {
      RpcProvider.prototype.callContract = async (call) => {
        switch (call.entrypoint) {
          case 'module_type':
            return ['0x6'];
          case 'is_paused':
            return [paused ? '0x1' : '0x0'];
          case 'owner':
            return ['0x123'];
          default:
            throw new Error(`Unexpected call ${call.entrypoint}`);
        }
      };
      expect(
        await new StarknetIsmArtifactManager(metadata).readIsm('0x3'),
      ).to.deep.equal({
        artifactState: ArtifactState.DEPLOYED,
        config: { type: 'pausableIsm', owner: address('0x123'), paused },
        deployed: { address: address('0x3') },
      });
    });
  }

  it('recognizes the published noop class and rejects other NULL modules', async () => {
    RpcProvider.prototype.callContract = async (call) => {
      if (call.entrypoint === 'module_type') return ['0x6'];
      throw new Error('Entry point not found in contract');
    };
    RpcProvider.prototype.getClassHashAt = async () =>
      getContractClassHash('noop_ism');
    const manager = new StarknetIsmArtifactManager(metadata);
    expect((await manager.readIsm('0x4')).config.type).to.equal('testIsm');
    RpcProvider.prototype.getClassHashAt = async () => '0x1234';
    expect(await rejection(manager.readIsm('0x4'))).to.match(
      /Unsupported Starknet ISM/,
    );
    expect(
      await rejection(manager.createReader('testIsm').read('0x4')),
    ).to.match(/Expected a verified Starknet noop/);
  });

  it('rejects unsupported module types rather than fabricating a testIsm', async () => {
    RpcProvider.prototype.callContract = async () => ['0x7', '0x123'];
    expect(
      await rejection(new StarknetIsmArtifactManager(metadata).readIsm('0x4')),
    ).to.match(/Unsupported Starknet ISM/);
  });

  it('propagates RPC failures while probing a NULL module', async () => {
    RpcProvider.prototype.callContract = async (call) => {
      if (call.entrypoint === 'module_type') return ['0x6'];
      throw new Error('RPC unavailable');
    };
    expect(
      await rejection(
        getIsmType(
          new RpcProvider({ nodeUrl: 'http://localhost:9545' }),
          '0x4',
        ),
      ),
    ).to.match(/RPC unavailable/);
  });

  it('continues to recognize routing and multisig module types', async () => {
    for (const [discriminant, expected] of [
      ['0x1', AltVM.IsmType.ROUTING],
      ['0x4', AltVM.IsmType.MERKLE_ROOT_MULTISIG],
      ['0x5', AltVM.IsmType.MESSAGE_ID_MULTISIG],
    ] as const) {
      RpcProvider.prototype.callContract = async () => [discriminant, '0x1'];
      expect(
        await getIsmType(
          new RpcProvider({ nodeUrl: 'http://localhost:9545' }),
          '0x1',
        ),
      ).to.equal(expected);
      RpcProvider.prototype.callContract = originalCall;
    }
  });
});
