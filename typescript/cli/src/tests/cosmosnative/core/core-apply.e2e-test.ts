import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { expect } from 'chai';

import { CosmosNativeSigner } from '@hyperlane-xyz/cosmos-sdk';
import {
  ChainMetadata,
  CoreConfig,
  IgpConfig,
  ProtocolReceipt,
  ProtocolTransaction,
  randomCosmosAddress,
} from '@hyperlane-xyz/sdk';
import { Address, AltVM, ProtocolType, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import {
  CHAIN_1_METADATA_PATH,
  CHAIN_NAME_1,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_1,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY,
  REGISTRY_PATH,
} from '../consts.js';

describe('hyperlane core apply e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_1,
  );

  let signer: AltVM.ISigner<
    ProtocolTransaction<ProtocolType.CosmosNative>,
    ProtocolReceipt<ProtocolType.CosmosNative>
  >;
  let initialOwnerAddress: Address;

  before(async () => {
    const chainMetadata: ChainMetadata = readYamlOrJson(CHAIN_1_METADATA_PATH);

    const wallet = await DirectSecp256k1Wallet.fromKey(
      Uint8Array.from(Buffer.from(HYP_KEY, 'hex')),
      'hyp',
    );

    assert(chainMetadata.gasPrice, 'gasPrice not defined in chain metadata');

    signer = await CosmosNativeSigner.connectWithSigner(
      chainMetadata.rpcUrls.map((rpc) => rpc.http),
      wallet,
      {
        metadata: chainMetadata,
      },
    );

    initialOwnerAddress = signer.getSignerAddress();
  });

  it('should update the mailbox owner', async () => {
    await hyperlaneCore.deploy(HYP_KEY);

    const coreConfig: CoreConfig = await hyperlaneCore.readConfig();

    expect(coreConfig.owner).to.equal(initialOwnerAddress);

    const newOwner = await randomCosmosAddress('hyp');
    coreConfig.owner = newOwner;

    writeYamlOrJson(CORE_READ_CONFIG_PATH_1, coreConfig);

    await hyperlaneCore.apply(HYP_KEY);

    // Verify that the owner has been set correctly without modifying any other owner values
    const updatedConfig: CoreConfig = await hyperlaneCore.readConfig();

    expect(updatedConfig.owner).to.equal(newOwner);
    // Assuming that the IGP is used for deployment
    expect((updatedConfig.defaultHook as IgpConfig).owner).to.equal(
      initialOwnerAddress,
    );
  });
});
