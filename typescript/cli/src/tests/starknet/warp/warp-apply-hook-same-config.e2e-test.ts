import { expect } from 'chai';

import { HookType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { HYP_DEPLOYER_ADDRESS_BY_PROTOCOL } from '../../constants.js';

import { describeStarknetSingleChainWarpApplyTest } from './warp-apply.shared.js';

describeStarknetSingleChainWarpApplyTest(
  'hyperlane warp apply Hook updates (Starknet E2E tests)',
  'should not redeploy protocolFee Hook when applying the same config twice',
  async ({
    chainName,
    warpDeployConfig,
    writeWarpDeployConfig,
    applyWarpConfig,
    readWarpConfig,
  }) => {
    warpDeployConfig[chainName].hook = {
      type: HookType.PROTOCOL_FEE,
      owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      beneficiary: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet,
      maxProtocolFee: '100',
      protocolFee: '10',
    };
    writeWarpDeployConfig();
    await applyWarpConfig();

    const firstHook = (await readWarpConfig())[chainName].hook;
    assert(firstHook && typeof firstHook !== 'string', 'Expected first Hook');

    await applyWarpConfig();

    const secondHook = (await readWarpConfig())[chainName].hook;
    assert(
      secondHook && typeof secondHook !== 'string',
      'Expected second Hook',
    );
    expect(secondHook.address).to.equal(firstHook.address);
  },
);
