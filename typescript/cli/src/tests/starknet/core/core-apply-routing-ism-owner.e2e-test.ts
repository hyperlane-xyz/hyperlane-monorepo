import { expect } from 'chai';

import { type CoreConfig, IsmType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
} from '../../constants.js';
import { normalizeStarknetAddress } from '../helpers.js';

import { describeStarknetCoreApplyTest } from './core-apply.shared.js';

describeStarknetCoreApplyTest(
  'should update the routing ISM owner without redeployment',
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
    assert(
      typeof coreConfig.defaultIsm !== 'string' &&
        coreConfig.defaultIsm.type === IsmType.ROUTING,
      'Expected core defaultIsm to be routing',
    );
    coreConfig.defaultIsm = {
      ...coreConfig.defaultIsm,
      owner: BURN_ADDRESS_BY_PROTOCOL.starknet,
    };
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
      coreConfig,
    );

    await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.starknet);

    const secondConfig = await hyperlaneCore.readConfig();
    assert(
      secondConfig.defaultIsm.type === IsmType.ROUTING,
      'Expected updated defaultIsm to remain routing',
    );
    expect(secondConfig.defaultIsm.address).to.equal(initialRoutingAddress);
    expect(normalizeStarknetAddress(secondConfig.defaultIsm.owner)).to.equal(
      normalizeStarknetAddress(BURN_ADDRESS_BY_PROTOCOL.starknet),
    );
  },
);
