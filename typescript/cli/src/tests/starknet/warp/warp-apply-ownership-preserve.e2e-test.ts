import { expect } from 'chai';

import { HYP_DEPLOYER_ADDRESS_BY_PROTOCOL } from '../../constants.js';
import { normalizeStarknetAddress } from '../helpers.js';

import { describeStarknetDualChainWarpApplyTest } from './warp-apply.shared.js';

describeStarknetDualChainWarpApplyTest(
  'hyperlane warp apply ownership (Starknet E2E tests)',
  'should preserve owners when reapplying the same config',
  async ({ chainName1, chainName2, applyWarpConfig, readWarpConfig }) => {
    await applyWarpConfig();

    const updatedWarpDeployConfig = await readWarpConfig();
    expect(
      normalizeStarknetAddress(updatedWarpDeployConfig[chainName1].owner),
    ).to.equal(
      normalizeStarknetAddress(HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet),
    );
    expect(
      normalizeStarknetAddress(updatedWarpDeployConfig[chainName2].owner),
    ).to.equal(
      normalizeStarknetAddress(HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet),
    );
  },
);
