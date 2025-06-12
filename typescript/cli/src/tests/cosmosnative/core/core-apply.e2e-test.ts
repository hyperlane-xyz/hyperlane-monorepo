import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { GasPrice } from '@cosmjs/stargate';
import { expect } from 'chai';

import { SigningHyperlaneModuleClient } from '@hyperlane-xyz/cosmos-sdk';
import {
  ChainMetadata,
  CoreConfig,
  IgpConfig,
  randomCosmosAddress,
} from '@hyperlane-xyz/sdk';
import { Address, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import {
  hyperlaneCoreApply,
  hyperlaneCoreDeploy,
  readCoreConfig,
} from '../commands/core.js';
import {
  CHAIN_1_METADATA_PATH,
  CHAIN_NAME_1,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_1,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY,
  REGISTRY_PATH,
} from '../commands/helpers.js';

describe('hyperlane core apply e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let signer: SigningHyperlaneModuleClient;
  let initialOwnerAddress: Address;

  before(async () => {
    const chainMetadata: ChainMetadata = readYamlOrJson(CHAIN_1_METADATA_PATH);

    const wallet = await DirectSecp256k1Wallet.fromKey(
      Buffer.from(HYP_KEY, 'hex'),
      'hyp',
    );

    assert(chainMetadata.gasPrice, 'gasPrice not defined in chain metadata');

    signer = await SigningHyperlaneModuleClient.connectWithSigner(
      chainMetadata.rpcUrls[0].http,
      wallet,
      {
        gasPrice: GasPrice.fromString(
          `${chainMetadata.gasPrice.amount}${chainMetadata.gasPrice.denom}`,
        ),
      },
    );

    initialOwnerAddress = signer.account.address;
  });

  it('should update the mailbox owner', async () => {
    await hyperlaneCoreDeploy(
      REGISTRY_PATH,
      HYP_KEY,
      CHAIN_NAME_1,
      CORE_CONFIG_PATH,
    );
    const coreConfig: CoreConfig = await readCoreConfig(
      REGISTRY_PATH,
      CHAIN_NAME_1,
      CORE_READ_CONFIG_PATH_1,
    );
    expect(coreConfig.owner).to.equal(initialOwnerAddress);
    const newOwner = await randomCosmosAddress('hyp');
    coreConfig.owner = newOwner;
    writeYamlOrJson(CORE_READ_CONFIG_PATH_1, coreConfig);
    await hyperlaneCoreApply(
      REGISTRY_PATH,
      HYP_KEY,
      CHAIN_NAME_1,
      CORE_READ_CONFIG_PATH_1,
    );
    // Verify that the owner has been set correctly without modifying any other owner values
    const updatedConfig: CoreConfig = await readCoreConfig(
      REGISTRY_PATH,
      CHAIN_NAME_1,
      CORE_READ_CONFIG_PATH_1,
    );
    expect(updatedConfig.owner).to.equal(newOwner);
    // Assuming that the IGP is used for deployment
    expect((updatedConfig.defaultHook as IgpConfig).owner).to.equal(
      initialOwnerAddress,
    );
  });
});
