import { expect } from 'chai';

import {
  WormholeConsistencyLevel,
  WormholeConsistencyType,
  consistencyLevelConfigFromOnchain,
  consistencyLevelForConfig,
} from './consistency.js';

describe('Wormhole consistency levels', () => {
  it('maps named consistency types to Wormhole wire values', () => {
    expect(
      consistencyLevelForConfig({
        type: WormholeConsistencyType.Instant,
      }),
    ).to.equal(WormholeConsistencyLevel.Instant);
    expect(
      consistencyLevelForConfig({ type: WormholeConsistencyType.Safe }),
    ).to.equal(WormholeConsistencyLevel.Safe);
    expect(
      consistencyLevelForConfig({
        type: WormholeConsistencyType.Finalized,
      }),
    ).to.equal(WormholeConsistencyLevel.Finalized);
    expect(
      consistencyLevelForConfig({
        type: WormholeConsistencyType.Custom,
        address: '0x0000000000000000000000000000000000000001',
        baseConsistencyLevel: WormholeConsistencyType.Instant,
        additionalBlocks: 2,
      }),
    ).to.equal(WormholeConsistencyLevel.Custom);
  });

  it('reconstructs custom consistency from contract getters', () => {
    expect(
      consistencyLevelConfigFromOnchain(WormholeConsistencyLevel.Custom, {
        address: '0x0000000000000000000000000000000000000001',
        baseConsistencyLevel: WormholeConsistencyLevel.Safe,
        additionalBlocks: 7,
      }),
    ).to.deep.equal({
      type: WormholeConsistencyType.Custom,
      address: '0x0000000000000000000000000000000000000001',
      baseConsistencyLevel: WormholeConsistencyType.Safe,
      additionalBlocks: 7,
    });
  });

  it('rejects unsupported standard consistency values', () => {
    expect(() => consistencyLevelConfigFromOnchain(15)).to.throw(
      'Unsupported standard Wormhole consistency level 15',
    );
  });
});
