import { expect } from 'chai';

import { IsmType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { describeStarknetSingleChainWarpApplyTest } from './warp-apply.shared.js';

describeStarknetSingleChainWarpApplyTest(
  'hyperlane warp apply ISM updates (Starknet E2E tests)',
  'should update ISM from nothing to testIsm',
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

    const ismConfig = (await readWarpConfig())[chainName]
      .interchainSecurityModule;
    assert(ismConfig && typeof ismConfig !== 'string', 'Expected ISM config');
    expect(ismConfig.type).to.equal(IsmType.TEST_ISM);
    expect(ismConfig.address).to.be.a('string');
  },
);
