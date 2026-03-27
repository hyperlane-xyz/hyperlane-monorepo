import { expect } from 'chai';

import { IsmType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { describeStarknetSingleChainWarpApplyTest } from './warp-apply.shared.js';

describeStarknetSingleChainWarpApplyTest(
  'hyperlane warp apply ISM updates (Starknet E2E tests)',
  'should not redeploy ISM when applying the same config twice',
  async ({
    chainName,
    warpDeployConfig,
    writeWarpDeployConfig,
    applyWarpConfig,
    readWarpConfig,
  }) => {
    warpDeployConfig[chainName].interchainSecurityModule = {
      type: IsmType.TEST_ISM,
    };
    writeWarpDeployConfig();
    await applyWarpConfig();

    const firstIsm = (await readWarpConfig())[chainName]
      .interchainSecurityModule;
    assert(firstIsm && typeof firstIsm !== 'string', 'Expected first ISM');

    await applyWarpConfig();

    const secondIsm = (await readWarpConfig())[chainName]
      .interchainSecurityModule;
    assert(secondIsm && typeof secondIsm !== 'string', 'Expected second ISM');
    expect(secondIsm.address).to.equal(firstIsm.address);
  },
);
