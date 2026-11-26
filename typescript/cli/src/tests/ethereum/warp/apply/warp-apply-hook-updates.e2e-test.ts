import { expect } from 'chai';

import {
  type AggregationHookConfig,
  type HookConfig,
  HookType,
  type PausableHookConfig,
  type RateLimitedHookConfig,
  TokenType,
  type WarpRouteDeployConfig,
  normalizeConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  ProtocolType,
  type WithAddress,
  assert,
} from '@hyperlane-xyz/utils';

import { writeYamlOrJson } from '../../../../utils/files.js';
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
  TEST_CHAIN_NAMES_BY_PROTOCOL,
} from '../../../constants.js';

describe('hyperlane warp apply E2E (hook updates)', async function () {
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

  it('should update hook configuration', async () => {
    const warpDeployConfig: WarpRouteDeployConfig = {
      [TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]: {
        type: TokenType.native,
        owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
      },
    };
    writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

    await evmWarpCommands.deploy(
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );

    // Update with a new hook config
    const owner = randomAddress();
    warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2].hook =
      {
        type: HookType.PROTOCOL_FEE,
        beneficiary: owner,
        maxProtocolFee: '1000000',
        protocolFee: '100000',
        owner,
      };

    // Write the updated config
    await writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

    // Apply the changes
    await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    const updatedWarpDeployConfig = await evmWarpCommands.readConfig(
      TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2,
      DEFAULT_EVM_WARP_CORE_PATH,
    );

    // Verify the hook was updated with all properties
    expect(
      normalizeConfig(
        updatedWarpDeployConfig[
          TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2
        ].hook,
      ),
    ).to.deep.equal(
      normalizeConfig(
        warpDeployConfig[TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2]
          .hook,
      ),
    );
  });

  it('should deploy a warp route with a RateLimitedHook and update its maxCapacity in place', async () => {
    const chain = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2;
    const owner = HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum;
    const initialMaxCapacity = (86400n * 100n).toString();
    const updatedMaxCapacity = (86400n * 200n).toString();

    const warpDeployConfig: WarpRouteDeployConfig = {
      [chain]: {
        type: TokenType.native,
        owner,
        hook: {
          type: HookType.RATE_LIMITED,
          maxCapacity: initialMaxCapacity,
          owner,
        } as RateLimitedHookConfig,
      },
    };

    await writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);
    await evmWarpCommands.deploy(
      HYP_KEY_BY_PROTOCOL.ethereum,
      DEFAULT_EVM_WARP_ID,
    );

    // Update maxCapacity in place (sender unchanged — same hook contract, just setRefillRate)
    (warpDeployConfig[chain].hook as RateLimitedHookConfig).maxCapacity =
      updatedMaxCapacity;
    await writeYamlOrJson(DEFAULT_EVM_WARP_DEPLOY_PATH, warpDeployConfig);

    const configBeforeApply = await evmWarpCommands.readConfig(
      chain,
      DEFAULT_EVM_WARP_CORE_PATH,
    );
    const hookAddressBeforeApply = (
      configBeforeApply[chain].hook as WithAddress<RateLimitedHookConfig>
    ).address;

    await evmWarpCommands.applyRaw({
      warpRouteId: DEFAULT_EVM_WARP_ID,
      hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
    });

    const updatedConfig = await evmWarpCommands.readConfig(
      chain,
      DEFAULT_EVM_WARP_CORE_PATH,
    );

    const hook = updatedConfig[chain]
      .hook as WithAddress<RateLimitedHookConfig>;
    expect(hook.type).to.equal(HookType.RATE_LIMITED);
    expect(hook.maxCapacity).to.equal(updatedMaxCapacity);
    // address must be unchanged — setRefillRate is in-place, not a redeploy
    expect(hook.address).to.equal(hookAddressBeforeApply);
  });

  describe('hook updates that keep the deployed hook', () => {
    const chain = TEST_CHAIN_NAMES_BY_PROTOCOL.ethereum.CHAIN_NAME_2;

    function pausableMember(owner: Address): PausableHookConfig {
      return { type: HookType.PAUSABLE, owner, paused: false };
    }

    function rateLimitedMember(
      owner: Address,
      maxCapacity = (86400n * 100n).toString(),
    ): RateLimitedHookConfig {
      return {
        type: HookType.RATE_LIMITED,
        owner,
        maxCapacity,
        duration: 86400n,
      };
    }

    function aggregationOf(...hooks: HookConfig[]): AggregationHookConfig {
      return { type: HookType.AGGREGATION, hooks };
    }

    function warpDeployConfigWithHook(hook: HookConfig): WarpRouteDeployConfig {
      return {
        [chain]: {
          type: TokenType.native,
          owner: HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum,
          hook,
        },
      };
    }

    async function deployWithHook(hook: HookConfig) {
      writeYamlOrJson(
        DEFAULT_EVM_WARP_DEPLOY_PATH,
        warpDeployConfigWithHook(hook),
      );
      await evmWarpCommands.deploy(
        HYP_KEY_BY_PROTOCOL.ethereum,
        DEFAULT_EVM_WARP_ID,
      );
    }

    async function applyWithHook(hook: HookConfig) {
      writeYamlOrJson(
        DEFAULT_EVM_WARP_DEPLOY_PATH,
        warpDeployConfigWithHook(hook),
      );
      await evmWarpCommands.applyRaw({
        warpRouteId: DEFAULT_EVM_WARP_ID,
        hypKey: HYP_KEY_BY_PROTOCOL.ethereum,
      });
    }

    // The hook the router points to, as the warp read derives it.
    async function readRouterHook() {
      const config = await evmWarpCommands.readConfig(
        chain,
        DEFAULT_EVM_WARP_CORE_PATH,
      );
      const hook = config[chain].hook;
      assert(hook && typeof hook !== 'string', `Expected a hook on ${chain}`);
      const address = 'address' in hook ? hook.address : undefined;
      assert(address, `Expected the hook on ${chain} to have an address`);
      return { address, hook };
    }

    // The hook of the router as an aggregation, with the address of each
    // member by its type.
    async function readRouterAggregation() {
      const { address, hook } = await readRouterHook();
      assert(
        hook.type === HookType.AGGREGATION,
        `Expected an aggregation hook on ${chain}, got ${hook.type}`,
      );
      const members: Record<string, Address> = {};
      for (const member of hook.hooks) {
        assert(
          typeof member !== 'string' &&
            'address' in member &&
            typeof member.address === 'string',
          'Expected the members of the aggregation to have an address',
        );
        members[member.type] = member.address;
      }
      return { address, hook, members };
    }

    it('keeps the hook when the same hook config is applied twice', async () => {
      const owner = randomAddress();
      const hook: HookConfig = {
        type: HookType.PROTOCOL_FEE,
        beneficiary: owner,
        maxProtocolFee: '1000000',
        protocolFee: '100000',
        owner,
      };
      await deployWithHook(hook);
      const { address: hookAddress } = await readRouterHook();

      await applyWithHook(hook);
      await applyWithHook(hook);

      const { address } = await readRouterHook();
      expect(address).to.equal(hookAddress);
    });

    it('keeps the aggregation hook and its members when the same hook config is applied twice', async () => {
      const hook = aggregationOf(
        pausableMember(randomAddress()),
        rateLimitedMember(HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum),
        { type: HookType.MAILBOX_DEFAULT },
      );
      await deployWithHook(hook);
      const before = await readRouterAggregation();

      await applyWithHook(hook);
      await applyWithHook(hook);

      const after = await readRouterAggregation();
      expect(after.address).to.equal(before.address);
      expect(after.members).to.deep.equal(before.members);
    });

    it('updates only the owner of a rate limited member of an aggregation hook in place', async () => {
      const pausableOwner = randomAddress();
      const newOwner = randomAddress();
      await deployWithHook(
        aggregationOf(
          pausableMember(pausableOwner),
          rateLimitedMember(HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum),
          { type: HookType.MAILBOX_DEFAULT },
        ),
      );
      const before = await readRouterAggregation();

      await applyWithHook(
        aggregationOf(
          pausableMember(pausableOwner),
          rateLimitedMember(newOwner),
          { type: HookType.MAILBOX_DEFAULT },
        ),
      );

      const after = await readRouterAggregation();
      expect(after.address).to.equal(before.address);
      expect(after.members).to.deep.equal(before.members);
      const rateLimited = after.hook.hooks.find(
        (member): member is RateLimitedHookConfig =>
          typeof member !== 'string' && member.type === HookType.RATE_LIMITED,
      );
      assert(rateLimited, 'Expected a rate limited member');
      expect(rateLimited.owner.toLowerCase()).to.equal(newOwner.toLowerCase());
    });

    it('updates the max capacity of a rate limited member of an aggregation hook in place', async () => {
      const owner = HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum;
      const pausableOwner = randomAddress();
      const updatedMaxCapacity = (86400n * 200n).toString();
      await deployWithHook(
        aggregationOf(pausableMember(pausableOwner), rateLimitedMember(owner), {
          type: HookType.MAILBOX_DEFAULT,
        }),
      );
      const before = await readRouterAggregation();

      await applyWithHook(
        aggregationOf(
          pausableMember(pausableOwner),
          rateLimitedMember(owner, updatedMaxCapacity),
          { type: HookType.MAILBOX_DEFAULT },
        ),
      );

      const after = await readRouterAggregation();
      expect(after.address).to.equal(before.address);
      expect(after.members).to.deep.equal(before.members);
      const rateLimited = after.hook.hooks.find(
        (member): member is RateLimitedHookConfig =>
          typeof member !== 'string' && member.type === HookType.RATE_LIMITED,
      );
      assert(rateLimited, 'Expected a rate limited member');
      expect(rateLimited.maxCapacity).to.equal(updatedMaxCapacity);
    });

    it('deploys a new aggregation hook when a member changes its type', async () => {
      const pausableOwner = randomAddress();
      const owner = HYP_DEPLOYER_ADDRESS_BY_PROTOCOL.ethereum;
      await deployWithHook(
        aggregationOf(pausableMember(pausableOwner), rateLimitedMember(owner), {
          type: HookType.MAILBOX_DEFAULT,
        }),
      );
      const before = await readRouterAggregation();

      await applyWithHook(
        aggregationOf(pausableMember(pausableOwner), rateLimitedMember(owner), {
          type: HookType.MERKLE_TREE,
        }),
      );

      const after = await readRouterAggregation();
      expect(after.address).to.not.equal(before.address);
      expect(Object.keys(after.members)).to.have.members([
        HookType.PAUSABLE,
        HookType.RATE_LIMITED,
        HookType.MERKLE_TREE,
      ]);
    });
  });
});
