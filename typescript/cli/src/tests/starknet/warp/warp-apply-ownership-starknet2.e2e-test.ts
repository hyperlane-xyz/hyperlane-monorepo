import { expect } from 'chai';

import {
  BURN_ADDRESS_BY_PROTOCOL,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
} from '../../constants.js';
import { normalizeStarknetAddress } from '../helpers.js';

import { describeStarknetDualChainWarpApplyTest } from './warp-apply.shared.js';

describeStarknetDualChainWarpApplyTest(
  'hyperlane warp apply ownership (Starknet E2E tests)',
  'should transfer ownership on starknet2',
  async ({
    chainName1,
    chainName2,
    warpDeployConfig,
    writeWarpDeployConfig,
    applyWarpConfig,
    readWarpConfig,
  }) => {
    warpDeployConfig[chainName1].owner =
      HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet;
    warpDeployConfig[chainName2].owner = BURN_ADDRESS_BY_PROTOCOL.starknet;
    writeWarpDeployConfig();

    await applyWarpConfig();

    const updatedWarpDeployConfig = await readWarpConfig();
    expect(
      normalizeStarknetAddress(updatedWarpDeployConfig[chainName1].owner),
    ).to.equal(
      normalizeStarknetAddress(HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.starknet),
    );
    expect(
      normalizeStarknetAddress(updatedWarpDeployConfig[chainName2].owner),
    ).to.equal(normalizeStarknetAddress(BURN_ADDRESS_BY_PROTOCOL.starknet));
  },
);
