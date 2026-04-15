import { expect } from 'chai';

import { IsmType, randomAddress } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { describeStarknetSingleChainWarpApplyTest } from './warp-apply.shared.js';

describeStarknetSingleChainWarpApplyTest(
  'hyperlane warp apply ISM updates (Starknet E2E tests)',
  'should update ISM from testIsm to messageIdMultisigIsm',
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

    warpDeployConfig[chainName].interchainSecurityModule = {
      type: IsmType.MESSAGE_ID_MULTISIG,
      threshold: 1,
      validators: [randomAddress()],
    };
    writeWarpDeployConfig();
    await applyWarpConfig();

    const ismConfig = (await readWarpConfig())[chainName]
      .interchainSecurityModule;
    assert(ismConfig && typeof ismConfig !== 'string', 'Expected ISM config');
    assert(
      ismConfig.type === IsmType.MESSAGE_ID_MULTISIG,
      'Expected messageIdMultisigIsm',
    );
    expect(ismConfig.threshold).to.equal(1);
    expect(ismConfig.validators).to.have.length(1);
  },
);
