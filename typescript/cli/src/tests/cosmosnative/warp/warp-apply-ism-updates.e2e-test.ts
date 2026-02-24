import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import { TokenType } from '@hyperlane-xyz/sdk';
import { type Address, ProtocolType } from '@hyperlane-xyz/utils';

import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import { createIsmUpdateTests } from '../../helpers/warp-ism-test-factory.js';
import {
  CHAIN_NAME_1,
  CORE_CONFIG_PATH,
  CORE_READ_CONFIG_PATH_1,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_KEY,
  REGISTRY_PATH,
  TEMP_PATH,
  WARP_CORE_CONFIG_PATH_1,
  WARP_DEPLOY_1_ID,
  WARP_DEPLOY_CONFIG_PATH_1,
} from '../consts.js';

describe('hyperlane warp apply ISM updates (Cosmos E2E tests)', async function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  const hyperlaneCore1 = new HyperlaneE2ECoreTestCommands(
    ProtocolType.CosmosNative,
    CHAIN_NAME_1,
    REGISTRY_PATH,
    CORE_CONFIG_PATH,
    CORE_READ_CONFIG_PATH_1,
  );

  const hyperlaneWarp = new HyperlaneE2EWarpTestCommands(
    ProtocolType.CosmosNative,
    REGISTRY_PATH,
    WARP_CORE_CONFIG_PATH_1,
  );

  let chain1Addresses: ChainAddresses;
  let ownerAddress: Address;
  let alternateOwnerAddress: Address;

  before(async function () {
    const wallet = await DirectSecp256k1Wallet.fromKey(
      Uint8Array.from(Buffer.from(HYP_KEY, 'hex')),
      'hyp',
    );
    const accounts = await wallet.getAccounts();
    ownerAddress = accounts[0].address;

    // Create alternate owner for routing ISM update test
    const alternateWallet = await DirectSecp256k1Wallet.fromKey(
      Uint8Array.from(
        Buffer.from(
          '0000000000000000000000000000000000000000000000000000000000000001',
          'hex',
        ),
      ),
      'hyp',
    );
    const alternateAccounts = await alternateWallet.getAccounts();
    alternateOwnerAddress = alternateAccounts[0].address;

    await hyperlaneCore1.deploy(HYP_KEY);
    chain1Addresses = await hyperlaneCore1.deployOrUseExistingCore(HYP_KEY);
  });

  createIsmUpdateTests(
    {
      protocol: ProtocolType.CosmosNative,
      chainName: CHAIN_NAME_1,
      get baseWarpConfig() {
        return {
          [CHAIN_NAME_1]: {
            type: TokenType.collateral,
            token: 'unative',
            mailbox: chain1Addresses.mailbox,
            owner: ownerAddress,
            name: 'Native Token',
            symbol: 'NATIVE',
            decimals: 6,
          },
        };
      },
      privateKey: HYP_KEY,
      warpRoutePath: WARP_CORE_CONFIG_PATH_1,
      warpDeployPath: WARP_DEPLOY_CONFIG_PATH_1,
      warpRouteId: WARP_DEPLOY_1_ID,
      warpReadOutputPath: `${TEMP_PATH}/warp-route-read.yaml`,
      get alternateOwnerAddress() {
        return alternateOwnerAddress;
      },
      skipTests: {
        updateTestIsmToDefaultIsm: true, // CosmosNative does not support unsetting ISMs
      },
    },
    hyperlaneCore1,
    hyperlaneWarp,
  );
});
