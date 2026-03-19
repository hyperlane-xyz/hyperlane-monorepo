import { expect } from 'chai';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type CoreConfig,
  type DerivedCoreConfig,
  HookType,
  IsmType,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';
import { SealevelIgpHookReader, createRpc } from '@hyperlane-xyz/sealevel-sdk';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CORE_ADDRESSES_PATH_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
} from '../../constants.js';

// SVM deploys programs from bytes (~90+ write-chunk transactions per program),
// so the suite needs a generous timeout.
const SVM_DEPLOY_TIMEOUT = 600_000;

describe('hyperlane core deploy (Sealevel E2E tests)', async function () {
  this.timeout(SVM_DEPLOY_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Sealevel,
    'svmlocal1',
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
  );

  it('should create a core deployment with the signer as the mailbox owner', async () => {
    const coreConfig: CoreConfig = await readYamlOrJson(
      CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
    );

    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      coreConfig,
    );
    hyperlaneCore.setCoreInputPath(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );

    await hyperlaneCore.deploy(HYP_KEY_BY_PROTOCOL.sealevel);

    // Validate core read (mailbox-level assertions)
    const derivedCoreConfig: DerivedCoreConfig =
      await hyperlaneCore.readConfig();

    expect(derivedCoreConfig.owner).to.equal(
      HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.sealevel,
    );
    expect(derivedCoreConfig.proxyAdmin?.owner).to.be.undefined;

    const deployedDefaultIsm = derivedCoreConfig.defaultIsm;
    assert(
      deployedDefaultIsm.type === IsmType.TEST_ISM,
      `Expected deployed defaultIsm to be of type ${IsmType.TEST_ISM}`,
    );

    // Validate the registry has the deployed addresses
    const addresses: ChainAddresses = await readYamlOrJson(
      CORE_ADDRESSES_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );
    expect(addresses.interchainGasPaymaster).to.be.a('string').that.is.not
      .empty;
    expect(addresses.mailbox).to.be.a('string').that.is.not.empty;
    expect(addresses.validatorAnnounce).to.be.a('string').that.is.not.empty;

    // Validate the IGP hook was properly deployed via direct hook read
    const rpc = createRpc(
      TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl,
    );
    // Zero salt matches DEFAULT_IGP_SALT used by the CLI core deploy flow.
    const igpReader = new SealevelIgpHookReader(rpc, new Uint8Array(32));
    assert(
      addresses.interchainGasPaymaster,
      'Expected interchainGasPaymaster address to be defined',
    );
    const igpArtifact = await igpReader.read(addresses.interchainGasPaymaster);
    assert(
      igpArtifact.config.type === HookType.INTERCHAIN_GAS_PAYMASTER,
      `Expected hook to be of type ${HookType.INTERCHAIN_GAS_PAYMASTER}, got ${igpArtifact.config.type}`,
    );
  });
});
