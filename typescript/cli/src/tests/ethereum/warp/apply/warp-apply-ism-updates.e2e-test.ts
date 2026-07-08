import { expect } from 'chai';
import { ethers } from 'ethers';

import { RateLimitedIsm__factory } from '@hyperlane-xyz/core';
import { AltVM } from '@hyperlane-xyz/provider-sdk';
import {
  type IsmConfig,
  IsmType,
  type RateLimitedIsmConfig,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  DEFAULT_EVM_WARP_CORE_PATH,
  DEFAULT_EVM_WARP_DEPLOY_PATH,
  DEFAULT_EVM_WARP_ID,
  DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../../constants.js';
import { deployTestOffchainLookupISM } from '../../commands/helpers.js';

const { TokenType } = AltVM;

describe('hyperlane warp apply E2E (ISM updates)', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    DEFAULT_EVM_WARP_READ_OUTPUT_PATH,
  );

  before(async function () {
    await evmChain2Core.deployOrUseExistingCore(HYP_KEY_BY_PROTOCOL.ethereum);
  });

  const testCases: {
    description: string;
    initialIsmConfig?: IsmConfig;
    targetIsmConfig: IsmConfig;
  }[] = [
    {
      description: 'should allow updating the default ism to a new ism',
      // Use the default ism
      targetIsmConfig: {
        type: IsmType.PAUSABLE,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        paused: false,
      },
    },
    {
      description:
        'should allow updating the ism configuration to the default ism (0 address)',
      targetIsmConfig: ethers.constants.AddressZero,
      initialIsmConfig: {
        type: IsmType.PAUSABLE,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        paused: false,
      },
    },
    {
      description: 'should pause the pausable ISM',
      initialIsmConfig: {
        type: IsmType.PAUSABLE,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        paused: false,
      },
      targetIsmConfig: {
        type: IsmType.PAUSABLE,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        paused: true,
      },
    },
    {
      description: 'should update the offchain lookup ism',
      targetIsmConfig: {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        urls: [
          'https://new-server.hyperlane.xyz/api',
          'https://backup-server.hyperlane.xyz/api',
        ],
      },
      initialIsmConfig: {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        urls: ['https://server.hyperlane.xyz/api'],
      },
    },
    {
      description:
        'should update the offchain lookup ism if the urls are not in the same order',
      targetIsmConfig: {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        urls: [
          'https://new-server.hyperlane.xyz/api',
          'https://backup-server.hyperlane.xyz/api',
        ],
      },
      initialIsmConfig: {
        type: IsmType.OFFCHAIN_LOOKUP,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
        urls: [
          'https://backup-server.hyperlane.xyz/api',
          'https://new-server.hyperlane.xyz/api',
        ],
      },
    },
  ];

  for (const { description, targetIsmConfig, initialIsmConfig } of testCases) {
    it(description, async () => {
      // CLI does not support deploying offchain lookup isms so we do it here
      let ismDeployConfig = initialIsmConfig;
      if (
        typeof initialIsmConfig !== 'string' &&
        initialIsmConfig?.type === IsmType.OFFCHAIN_LOOKUP
      ) {
        const testOffchainLookupIsm = await deployTestOffchainLookupISM(
          HYP_KEY_BY_PROTOCOL.ethereum,
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
          initialIsmConfig.urls,
          REGISTRY_PATH,
        );

        ismDeployConfig = testOffchainLookupIsm.address;
      }

      const warpDeployConfig: WarpRouteDeployConfig = {
        [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
          type: TokenType.native,
          owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
          interchainSecurityModule: ismDeployConfig,
        },
      };

      await writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);
      await evmWarpCommands.deploy(
        HYP_KEY_BY_PROTOCOL.ethereum,
        DEFAULT_EVM_WARP_ID,
      );

      // Write the updated config
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].interchainSecurityModule = targetIsmConfig;
      await writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

      // Apply the changes
      await evmWarpCommands.applyRaw({
        warpRouteId: DEFAULT_EVM_WARP_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      // Read back the config to verify changes
      const updatedConfig = await evmWarpCommands.readConfig(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        DEFAULT_EVM_WARP_CORE_PATH,
      );

      expect(
        normalizeConfig(
          updatedConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
            .interchainSecurityModule,
        ),
      ).to.deep.equal(normalizeConfig(targetIsmConfig));
    });
  }

  it('should apply a RateLimitedIsm and auto-populate recipient from deployed token address', async () => {
    const maxCapacity = (BigInt(86400) * 10n ** 18n).toString();
    const chain2 = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2;

    const warpDeployConfig: WarpRouteDeployConfig = {
      [chain2]: {
        type: TokenType.native,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      },
    };

    await writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);
    await evmWarpCommands.deploy(
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );

    const warpCoreConfig: WarpCoreConfig = readYamlOrJson(
      DEFAULT_EVM_WARP_CORE_PATH,
    );
    const tokenEntry = warpCoreConfig.tokens.find(
      (t) => t.chainName === chain2,
    );
    expect(tokenEntry).to.exist;
    const tokenAddress = tokenEntry!.addressOrDenom!;

    warpDeployConfig[chain2].interchainSecurityModule = {
      type: IsmType.RATE_LIMITED,
      maxCapacity,
    };
    await writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    const updatedConfig = await evmWarpCommands.readConfig(
      chain2,
      DEFAULT_EVM_WARP_CORE_PATH,
    );

    const ism = updatedConfig[chain2]
      .interchainSecurityModule as RateLimitedIsmConfig & { address: string };
    expect(ism).to.exist;
    expect(ism.type).to.equal(IsmType.RATE_LIMITED);
    expect(ism.maxCapacity).to.equal(maxCapacity);
    // recipient is stripped from read() output — verify on-chain directly
    expect(ism.address).to.not.be.undefined;
    const chain2Metadata =
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
    const provider = new ethers.providers.JsonRpcProvider(
      chain2Metadata.rpcUrl,
    );
    const onChainRecipient = await RateLimitedIsm__factory.connect(
      ism.address,
      provider,
    ).recipient();
    expect(onChainRecipient.toLowerCase()).to.equal(tokenAddress.toLowerCase());
  });
});
