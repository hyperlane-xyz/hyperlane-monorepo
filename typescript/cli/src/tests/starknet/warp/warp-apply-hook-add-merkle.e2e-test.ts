import { expect } from 'chai';

import { HookType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { describeStarknetSingleChainWarpApplyTest } from './warp-apply.shared.js';

describeStarknetSingleChainWarpApplyTest(
  'hyperlane warp apply Hook updates (Starknet E2E tests)',
  'should update Hook from nothing to MerkleTreeHook',
  async ({
    chainName,
    warpDeployConfig,
    writeWarpDeployConfig,
    applyWarpConfig,
    readWarpConfig,
  }) => {
    warpDeployConfig[chainName].hook = {
      type: HookType.MERKLE_TREE,
    };
    writeWarpDeployConfig();

    await applyWarpConfig();

    const hookConfig = (await readWarpConfig())[chainName].hook;
    assert(
      hookConfig && typeof hookConfig !== 'string',
      'Expected Hook config',
    );
    expect(hookConfig.type).to.equal(HookType.MERKLE_TREE);
    expect(hookConfig.address).to.be.a('string');
  },
);
