import { expect } from 'chai';

import {
  type CoreConfig,
  type DerivedCoreConfig,
  HookType,
  IsmType,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../constants.js';
import {
  normalizeStarknetAddress,
  updateProtocolFeeCoreConfig,
} from '../helpers.js';

describe('hyperlane core apply (Starknet E2E tests)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Starknet,
    TEST_CHAIN_NAMES_BY_PROTOCOL.starknet.CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
  );

  beforeEach(async () => {
    const coreConfig: CoreConfig = readYamlOrJson(
      CORE_CONFIG_PATH_BY_PROTOCOL.starknet,
    );
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
      coreConfig,
    );
    hyperlaneCore.setCoreInputPath(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.starknet.CHAIN_NAME_1,
    );
    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.starknet);
  });

  it('should update the mailbox owner', async () => {
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
  });

  it('should update the defaultHook protocol fee config without redeployment', async () => {
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
  });

  it('should redeploy the defaultIsm when immutable config changes', async () => {
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
  });

  it('should update the routing ISM owner without redeployment', async () => {
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
  });
});
