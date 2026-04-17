import { JsonRpcProvider } from '@ethersproject/providers';
import { expect } from 'chai';
import { Wallet } from 'ethers';

import {
  MockPredicateRegistry__factory,
  PredicateRouterWrapper__factory,
  StaticAggregationHook__factory,
  TokenRouter__factory,
} from '@hyperlane-xyz/core';
import {
  OnchainHookType,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../../commands/core.js';
import { HyperlaneE2EWarpTestCommands } from '../../../commands/warp.js';
import {
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  DEFAULT_E2E_TEST_TIMEOUT,
  HYP_DEPLOYER_ADDRESS_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  TEST_CHAIN_NAMES_BY_PROTOCOL,
  getArtifactReadPath,
  getWarpCoreConfigPath,
  getWarpDeployConfigPath,
  getWarpId,
} from '../../../constants.js';

const CHAIN_NAME_2 = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
const HYP_KEY = HYP_KEY_BY_PROTOCOL.ethereum;
const OWNER = HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum;
// Anvil account[1] used as the new predicate wrapper owner
const NEW_OWNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const WARP_SYMBOL = 'PREDAPPLY';
const WARP_ID = getWarpId(WARP_SYMBOL, [CHAIN_NAME_2]);
const WARP_CORE_PATH = getWarpCoreConfigPath(WARP_SYMBOL, [CHAIN_NAME_2]);
const WARP_DEPLOY_PATH = getWarpDeployConfigPath(WARP_SYMBOL, [CHAIN_NAME_2]);
const WARP_READ_OUTPUT_PATH = getArtifactReadPath(WARP_SYMBOL, [
  CHAIN_NAME_2,
  'read',
]);
const MOCK_POLICY_ID = 'x-test-policy-predicate-apply-e2e';

/**
 * Scans the sub-hooks of a StaticAggregationHook to find a PredicateRouterWrapper.
 * Returns the wrapper address or undefined if none is found.
 */
async function findPredicateWrapperInAggregation(
  aggregationHookAddress: string,
  wallet: Wallet,
): Promise<string | undefined> {
  const aggregationHook = StaticAggregationHook__factory.connect(
    aggregationHookAddress,
    wallet,
  );
  let hookAddresses: string[];
  try {
    hookAddresses = await aggregationHook.hooks('0x');
  } catch {
    // Not a StaticAggregationHook (e.g. bare IGP after predicate removal)
    return undefined;
  }
  for (const addr of hookAddresses) {
    try {
      const candidate = PredicateRouterWrapper__factory.connect(addr, wallet);
      if (
        (await candidate.hookType()) ===
        OnchainHookType.PREDICATE_ROUTER_WRAPPER
      ) {
        return addr;
      }
    } catch {
      // Not a PredicateRouterWrapper — continue
    }
  }
  return undefined;
}

const BASE_DEPLOY_CONFIG: WarpRouteDeployConfig = {
  [CHAIN_NAME_2]: {
    type: TokenType.native,
    owner: OWNER,
  },
};

describe('hyperlane warp apply E2E (predicate wrapper updates)', async function () {
  this.timeout(3 * DEFAULT_E2E_TEST_TIMEOUT);

  let mockPredicateRegistryAddress: string;
  let routerAddress: string;
  let wallet: Wallet;
  let savedCoreConfig: WarpCoreConfig;

  const evmChain2Core = new HyperlaneE2ECoreTestCommands(
    ProtocolType.Ethereum,
    CHAIN_NAME_2,
    REGISTRY_PATH,
    CORE_CONFIG_PATH_BY_PROTOCOL.ethereum,
    CORE_READ_CONFIG_PATH_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
  );

  const evmWarpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Ethereum,
    REGISTRY_PATH,
    WARP_READ_OUTPUT_PATH,
  );

  before(async function () {
    await evmChain2Core.deployOrUseExistingCore(HYP_KEY);

    const { rpcUrl } = TEST_CHAIN_METADATA_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
    const provider = new JsonRpcProvider(rpcUrl);
    wallet = new Wallet(HYP_KEY).connect(provider);

    // Deploy a mock predicate registry for use across all test cases
    const mockRegistry = await new MockPredicateRegistry__factory(
      wallet,
    ).deploy();
    await mockRegistry.deployed();
    mockPredicateRegistryAddress = mockRegistry.address;

    // Deploy initial warp route without predicate wrapper
    await writeYamlOrJson(WARP_DEPLOY_PATH, BASE_DEPLOY_CONFIG);
    await evmWarpCommands.deploy(HYP_KEY, WARP_ID);

    // Resolve and cache the router address and core config for restoration between tests
    savedCoreConfig = readYamlOrJson(WARP_CORE_PATH);
    const token = savedCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_2,
    );
    expect(token?.addressOrDenom).to.exist;
    routerAddress = token!.addressOrDenom!;
  });

  // The global e2e-test.setup.ts beforeEach deletes the entire warp_routes directory
  // before each test. We restore the core config and a base deploy config so that
  // warp apply can resolve the warp route ID from the registry.
  beforeEach(function () {
    if (!savedCoreConfig) return;
    writeYamlOrJson(WARP_CORE_PATH, savedCoreConfig);
    writeYamlOrJson(WARP_DEPLOY_PATH, BASE_DEPLOY_CONFIG);
  });

  it('should have no predicate wrapper after initial deploy', async function () {
    const router = TokenRouter__factory.connect(routerAddress, wallet);
    const hookAddress = await router.hook();
    // No hook configured → zero address (mailbox default used at dispatch time)
    expect(hookAddress).to.equal('0x0000000000000000000000000000000000000000');
  });

  it('should add predicate wrapper via warp apply', async function () {
    const warpDeployConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        owner: OWNER,
        predicateWrapper: {
          predicateRegistry: mockPredicateRegistryAddress,
          policyId: MOCK_POLICY_ID,
          owner: OWNER,
        },
      },
    };
    await writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpRouteId: WARP_ID,
      hypKey: HYP_KEY,
      skipConfirmationPrompts: true,
    });

    // The router's hook should now be a StaticAggregationHook wrapping the PredicateRouterWrapper
    const router = TokenRouter__factory.connect(routerAddress, wallet);
    const hookAddress = await router.hook();
    expect(hookAddress).to.not.equal(
      '0x0000000000000000000000000000000000000000',
    );

    const predicateWrapperAddress = await findPredicateWrapperInAggregation(
      hookAddress,
      wallet,
    );
    expect(predicateWrapperAddress).to.exist;

    const predicateWrapper = PredicateRouterWrapper__factory.connect(
      predicateWrapperAddress!,
      wallet,
    );
    expect(await predicateWrapper.warpRoute()).to.equal(routerAddress);
    expect(await predicateWrapper.getRegistry()).to.equal(
      mockPredicateRegistryAddress,
    );
    expect(await predicateWrapper.getPolicyID()).to.equal(MOCK_POLICY_ID);
    expect(await predicateWrapper.owner()).to.equal(OWNER);
  });

  it('should transfer predicate wrapper ownership without redeploying the wrapper', async function () {
    // NOTE: this test mutates the wrapper owner to NEW_OWNER.
    // The removal test below runs after this one and verifies the wrapper is gone.
    // Snapshot hook and wrapper addresses before the update to verify no redeployment
    const router = TokenRouter__factory.connect(routerAddress, wallet);
    const hookAddressBefore = await router.hook();
    const wrapperAddressBefore = await findPredicateWrapperInAggregation(
      hookAddressBefore,
      wallet,
    );
    expect(wrapperAddressBefore).to.exist;

    // Apply with only the owner changed
    const warpDeployConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        owner: OWNER,
        predicateWrapper: {
          predicateRegistry: mockPredicateRegistryAddress,
          policyId: MOCK_POLICY_ID,
          owner: NEW_OWNER,
        },
      },
    };
    await writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpRouteId: WARP_ID,
      hypKey: HYP_KEY,
      skipConfirmationPrompts: true,
    });

    // Hook and wrapper contract addresses must be unchanged (no redeploy)
    const hookAddressAfter = await router.hook();
    expect(hookAddressAfter).to.equal(hookAddressBefore);

    const wrapperAddressAfter = await findPredicateWrapperInAggregation(
      hookAddressAfter,
      wallet,
    );
    expect(wrapperAddressAfter).to.equal(wrapperAddressBefore);

    // Ownership must reflect the new owner
    const predicateWrapper = PredicateRouterWrapper__factory.connect(
      wrapperAddressAfter!,
      wallet,
    );
    expect(await predicateWrapper.owner()).to.equal(NEW_OWNER);

    // Registry and policyId must be unchanged
    expect(await predicateWrapper.getRegistry()).to.equal(
      mockPredicateRegistryAddress,
    );
    expect(await predicateWrapper.getPolicyID()).to.equal(MOCK_POLICY_ID);
  });

  it('should remove predicate wrapper via warp apply and clear the custom hook', async function () {
    const router = TokenRouter__factory.connect(routerAddress, wallet);
    const aggregationHookBefore = await router.hook();
    expect(aggregationHookBefore).to.not.equal(
      '0x0000000000000000000000000000000000000000',
      'expected predicate aggregation hook to be set before removal',
    );

    // Apply config with predicateWrapper omitted — signals removal
    const warpDeployConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        owner: OWNER,
        // No predicateWrapper field, no hook field
      },
    };
    writeYamlOrJson(WARP_DEPLOY_PATH, warpDeployConfig);

    await evmWarpCommands.applyRaw({
      warpRouteId: WARP_ID,
      hypKey: HYP_KEY,
      skipConfirmationPrompts: true,
    });

    // The hook must be cleared to zero: removing predicateWrapper without supplying
    // a replacement hook resets the router to the mailbox default (zero address).
    const hookAddressAfter = await router.hook();
    expect(hookAddressAfter).to.equal(
      '0x0000000000000000000000000000000000000000',
    );
  });
});
