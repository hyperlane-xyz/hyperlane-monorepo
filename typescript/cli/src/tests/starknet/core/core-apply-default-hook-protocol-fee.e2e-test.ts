import { expect } from 'chai';

import {
  type CoreConfig,
  type DerivedCoreConfig,
  HookType,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
} from '../../constants.js';
import {
  normalizeStarknetAddress,
  updateProtocolFeeCoreConfig,
} from '../helpers.js';

import { describeStarknetCoreApplyTest } from './core-apply.shared.js';

describeStarknetCoreApplyTest(
  'should update the defaultHook protocol fee config without redeployment',
  async (hyperlaneCore) => {
    let derivedCoreConfig: DerivedCoreConfig = await hyperlaneCore.readConfig();
    const initialHookAddress = derivedCoreConfig.defaultHook.address;

    const coreConfig: CoreConfig = readYamlOrJson(
      CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    );
    updateProtocolFeeCoreConfig(coreConfig, {
      beneficiary: BURN_ADDRESS_BY_PROTOCOL.starknet,
      owner: BURN_ADDRESS_BY_PROTOCOL.starknet,
      protocolFee: '11',
    });
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
      coreConfig,
    );

    await hyperlaneCore.apply(HYP_KEY_BY_PROTOCOL.starknet);

    derivedCoreConfig = await hyperlaneCore.readConfig();
    expect(derivedCoreConfig.defaultHook.type).to.equal(HookType.PROTOCOL_FEE);
    expect(derivedCoreConfig.defaultHook.address).to.equal(initialHookAddress);
    assert(
      derivedCoreConfig.defaultHook.type === HookType.PROTOCOL_FEE,
      'Expected defaultHook to remain protocolFee',
    );
    expect(
      normalizeStarknetAddress(derivedCoreConfig.defaultHook.owner),
    ).to.equal(normalizeStarknetAddress(BURN_ADDRESS_BY_PROTOCOL.starknet));
    expect(derivedCoreConfig.defaultHook.protocolFee).to.equal('11');
  },
);
