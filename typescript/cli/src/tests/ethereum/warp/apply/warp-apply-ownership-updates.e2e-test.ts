import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  ProxyAdmin__factory,
  TimelockController__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  CANCELLER_ROLE,
  EXECUTOR_ROLE,
  type HypTokenRouterConfig,
  PROPOSER_ROLE,
  TokenFeeType,
  TokenType,
  proxyAdmin,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  ProtocolType,
  normalizeAddress,
} from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../../commands/warp.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
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
import { WarpTestFixture } from '../../fixtures/warp-test-fixture.js';

describe('hyperlane warp apply E2E (ownership updates)', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const fixture = new WarpTestFixture({
    initialDeployConfig: {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.native,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      },
    },
    deployConfigPath: DEFAULT_EVM_WARP_DEPLOY_PATH,
    coreConfigPath: DEFAULT_EVM_WARP_CORE_PATH,
  });

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

    fixture.writeConfigs();
    await evmWarpCommands.deploy(
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );

    fixture.loadCoreConfig();
    await fixture.createSnapshot({
      rpcUrl: TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.rpcUrl,
      chainName: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    });
  });

  beforeEach(async function () {
    fixture.restoreConfigs();
    await fixture.restoreSnapshot({
      rpcUrl: TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.rpcUrl,
      chainName: TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
    });
  });

  it('should not update the same owner', async () => {
    const output = await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    expect(output.text()).to.include(
      'Warp config is the same as target. No updates needed.',
    );
  });

  const testCases: {
    description: string;
    tokenOwner: string;
    proxyAdminOwner?: string;
    ownerOverridesProxyAdmin?: string;
  }[] = [
    {
      description: 'should burn owner address',
      tokenOwner: BURN_ADDRESS_BY_PROTOCOL.ethereum,
    },
    {
      description:
        'should update the owner of both the warp token and the proxy admin',
      tokenOwner: randomAddress(),
    },
    {
      description:
        'should update only the owner of the warp token if the proxy admin config is specified',
      proxyAdminOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      tokenOwner: randomAddress(),
    },
    {
      description:
        'should update only the owner of the proxy admin if the proxy admin config is specified',
      tokenOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      proxyAdminOwner: randomAddress(),
    },
    {
      description:
        'should update proxyAdmin owner using ownerOverrides.proxyAdmin',
      tokenOwner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      ownerOverridesProxyAdmin: randomAddress(),
    },
  ];

  for (const {
    description,
    proxyAdminOwner,
    tokenOwner,
    ownerOverridesProxyAdmin,
  } of testCases) {
    it(description, async function () {
      const expectedTokenOwner: Address = tokenOwner;
      const expectedProxyAdminOwner: Address =
        ownerOverridesProxyAdmin ?? proxyAdminOwner ?? expectedTokenOwner;

      const warpDeployConfig = fixture.getDeployConfig();
      warpDeployConfig[
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
      ].owner = tokenOwner;

      if (proxyAdminOwner) {
        warpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
        ].proxyAdmin = { owner: proxyAdminOwner };
      }

      if (ownerOverridesProxyAdmin) {
        warpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
        ].ownerOverrides = { proxyAdmin: ownerOverridesProxyAdmin };
      }
      writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

      await evmWarpCommands.applyRaw({
        warpRouteId: DEFAULT_EVM_WARP_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });

      const updatedWarpDeployConfig = await evmWarpCommands.readConfig(
        TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
        DEFAULT_EVM_WARP_CORE_PATH,
      );

      expect(
        normalizeAddress(
          updatedWarpDeployConfig[
            TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
          ].owner,
        ),
      ).to.eq(normalizeAddress(expectedTokenOwner));
      expect(
        normalizeAddress(
          updatedWarpDeployConfig[
            TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
          ].proxyAdmin!.owner,
        ),
      ).to.eq(normalizeAddress(expectedProxyAdminOwner));
    });
  }

  it('should succeed on re-run after ownership transfer with tokenFee configured (idempotency)', async function () {
    const newOwner = randomAddress();
    const feeOwner = HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum;
    const tokenFeeConfig = {
      type: TokenFeeType.LinearFee,
      owner: feeOwner,
      bps: 100,
    };

    const warpDeployConfig = fixture.getDeployConfig();
    warpDeployConfig[
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
    ].tokenFee = tokenFeeConfig;
    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    const configWithNewOwner = fixture.getDeployConfig();
    configWithNewOwner[
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
    ].owner = newOwner;
    configWithNewOwner[
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
    ].tokenFee = tokenFeeConfig;
    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, configWithNewOwner);

    await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    const secondApply = await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    expect(secondApply.exitCode).to.equal(0);
  });

  it('should apply timelock config to the ProxyAdmin only and reuse it', async function () {
    const chain = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
    const expectedOwner = HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum;
    const delay = 259200;

    const warpDeployConfig = fixture.getDeployConfig();
    // CAST: fixture returns a route map; this test narrows the known EVM chain
    // entry to mutate timelock config.
    const chainConfig = warpDeployConfig[chain] as HypTokenRouterConfig;
    chainConfig.timelock = {
      delay,
      roles: {
        executor: expectedOwner,
        proposer: expectedOwner,
      },
    };
    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

    const firstApply = await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });
    expect(firstApply.exitCode).to.equal(0);

    const provider = new ethers.providers.JsonRpcProvider(
      TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2.rpcUrl,
    );
    const routerAddress = evmWarpCommands.getDeployedWarpAddress(
      chain,
      DEFAULT_EVM_WARP_CORE_PATH,
    );
    const proxyAdminAddress = await proxyAdmin(provider, routerAddress);
    const proxyAdminOwner = await ProxyAdmin__factory.connect(
      proxyAdminAddress,
      provider,
    ).owner();
    const routerOwner = await TokenRouter__factory.connect(
      routerAddress,
      provider,
    ).owner();

    expect(normalizeAddress(routerOwner)).to.equal(
      normalizeAddress(expectedOwner),
    );
    expect(normalizeAddress(proxyAdminOwner)).to.not.equal(
      normalizeAddress(expectedOwner),
    );

    const timelock = TimelockController__factory.connect(
      proxyAdminOwner,
      provider,
    );
    expect((await timelock.getMinDelay()).toNumber()).to.equal(delay);
    expect(await timelock.hasRole(PROPOSER_ROLE, expectedOwner)).to.be.true;
    expect(await timelock.hasRole(EXECUTOR_ROLE, expectedOwner)).to.be.true;
    expect(await timelock.hasRole(CANCELLER_ROLE, expectedOwner)).to.be.true;
    expect(
      await timelock.hasRole(
        await timelock.TIMELOCK_ADMIN_ROLE(),
        timelock.address,
      ),
    ).to.be.true;

    await evmWarpCommands.checkRaw({ warpRouteId: DEFAULT_EVM_WARP_ID });
    await evmWarpCommands.checkRaw({});

    const secondApply = await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });
    expect(secondApply.text()).to.include(
      'Warp config is the same as target. No updates needed.',
    );

    const secondProxyAdminOwner = await ProxyAdmin__factory.connect(
      proxyAdminAddress,
      provider,
    ).owner();
    expect(normalizeAddress(secondProxyAdminOwner)).to.equal(
      normalizeAddress(proxyAdminOwner),
    );
  });
});
