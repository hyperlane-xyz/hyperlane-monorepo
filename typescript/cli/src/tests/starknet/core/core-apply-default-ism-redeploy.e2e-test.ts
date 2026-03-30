import { expect } from 'chai';

import { type CoreConfig, IsmType, randomAddress } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
} from '../../constants.js';

import { describeStarknetCoreApplyTest } from './core-apply.shared.js';

describeStarknetCoreApplyTest(
  'should redeploy the defaultIsm when immutable config changes',
  async (hyperlaneCore) => {
    const firstConfig = await hyperlaneCore.readConfig();
    assert(
      firstConfig.defaultIsm.type === IsmType.ROUTING,
      'Expected initial defaultIsm to be routing',
    );
    const initialRoutingAddress = firstConfig.defaultIsm.address;

    const coreConfig: CoreConfig = readYamlOrJson(
      CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    );
    coreConfig.defaultIsm = {
      type: IsmType.MESSAGE_ID_MULTISIG,
      threshold: 1,
      validators: [randomAddress()],
    };
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
      coreConfig,
    );

    await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.starknet);

    const secondConfig = await hyperlaneCore.readConfig();
    assert(
      secondConfig.defaultIsm.type === IsmType.MESSAGE_ID_MULTISIG,
      'Expected updated defaultIsm to be messageIdMultisig',
    );
    expect(secondConfig.defaultIsm.address).to.not.equal(initialRoutingAddress);
    expect(secondConfig.defaultIsm.threshold).to.equal(1);
  },
);
