import { expect } from 'chai';
import { Signer, Wallet, ethers } from 'ethers';

import { CoreConfig, ProtocolFeeHookConfig } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../utils/files.js';

import { hyperlaneCoreDeploy, readCoreConfig } from './commands/core.js';
import {
  ANVIL_KEY,
  CHAIN_2_CORE_READ_CONFIG_PATH,
  CHAIN_NAME_2,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from './commands/helpers.js';

describe('hyperlane core read e2e tests', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let signer: Signer;
  let initialOwnerAddress: Address;

  before(async () => {
    const chainMetadata: any = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${CHAIN_NAME_2}/metadata.yaml`,
    );

    const provider = new ethers.providers.JsonRpcProvider(
      chainMetadata.rpcUrls[0].http,
    );

    const wallet = new Wallet(ANVIL_KEY);
    signer = wallet.connect(provider);

    initialOwnerAddress = await signer.getAddress();
  });

  it('should read a core deployment', async () => {
    await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);

    const coreConfig: CoreConfig = await readCoreConfig(
      CHAIN_NAME_2,
      CHAIN_2_CORE_READ_CONFIG_PATH,
    );

    expect(coreConfig.owner).to.equal(initialOwnerAddress);
    expect(coreConfig.proxyAdmin?.owner).to.equal(initialOwnerAddress);
    expect(coreConfig.requiredHook).not.to.be.undefined;
    expect(coreConfig.defaultHook).not.to.be.undefined;
    expect(coreConfig.defaultIsm).not.to.be.undefined;
    // Assuming that the ProtocolFeeHook is used for deployment
    expect((coreConfig.requiredHook as ProtocolFeeHookConfig).owner).to.equal(
      initialOwnerAddress,
    );
  });
});
