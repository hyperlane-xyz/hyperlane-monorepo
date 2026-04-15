import { expect } from 'chai';

import { HookType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  BURN_ADDRESS_BY_PROTOCOL,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
} from '../../constants.js';
import { normalizeStarknetAddress } from '../helpers.js';

import { describeStarknetSingleChainWarpApplyTest } from './warp-apply.shared.js';

describeStarknetSingleChainWarpApplyTest(
  'hyperlane warp apply Hook updates (Starknet E2E tests)',
  'should update protocolFee Hook config without redeployment',
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
    expect(firstHook.type).to.equal(HookType.PROTOCOL_FEE);

    warpDeployConfig[chainName].hook = {
      type: HookType.PROTOCOL_FEE,
      owner: BURN_ADDRESS_BY_PROTOCOL.starknet,
      beneficiary: BURN_ADDRESS_BY_PROTOCOL.starknet,
      maxProtocolFee: '100',
      protocolFee: '11',
    };
    writeWarpDeployConfig();
    await applyWarpConfig();

    const secondHook = (await readWarpConfig())[chainName].hook;
    assert(
      secondHook && typeof secondHook !== 'string',
      'Expected second Hook',
    );
    expect(secondHook.type).to.equal(HookType.PROTOCOL_FEE);
    assert(
      secondHook.type === HookType.PROTOCOL_FEE,
      'Expected protocolFee Hook',
    );
    expect(secondHook.address).to.equal(firstHook.address);
    expect(normalizeStarknetAddress(secondHook.owner)).to.equal(
      normalizeStarknetAddress(BURN_ADDRESS_BY_PROTOCOL.starknet),
    );
    expect(normalizeStarknetAddress(secondHook.beneficiary)).to.equal(
      normalizeStarknetAddress(BURN_ADDRESS_BY_PROTOCOL.starknet),
    );
    expect(secondHook.protocolFee).to.equal('11');
  },
);
