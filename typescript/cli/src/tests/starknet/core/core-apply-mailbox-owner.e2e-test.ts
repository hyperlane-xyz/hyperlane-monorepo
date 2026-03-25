import { expect } from 'chai';

import { type CoreConfig } from '@hyperlane-xyz/sdk';

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
  'should update the mailbox owner',
  async (hyperlaneCore) => {
    const coreConfig: CoreConfig = readYamlOrJson(
      CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    );
    coreConfig.owner = BURN_ADDRESS_BY_PROTOCOL.starknet;
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
      coreConfig,
    );

    await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.starknet);

    const derivedCoreConfig = await hyperlaneCore.readConfig();
    expect(normalizeStarknetAddress(derivedCoreConfig.owner)).to.equal(
      normalizeStarknetAddress(BURN_ADDRESS_BY_PROTOCOL.starknet),
    );
  },
);
