import { readFileSync, writeFileSync } from 'fs';

import { expect } from 'chai';
import { Contract, Wallet, constants, providers, utils } from 'ethers';
import { $ } from 'zx';

import {
  type ERC20Test,
  type XERC20LockboxTest,
  type XERC20VSTest,
} from '@hyperlane-xyz/core';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type AevoXERC20Limits,
  type ChainMetadata,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
  XERC20AevoCapType,
  XERC20Type,
  XERC20_AEVO_ABI,
  isXERC20TokenConfig,
  randomAddress,
} from '@hyperlane-xyz/sdk';
import {
  type Address,
  assert,
  eqAddress,
  isNullish,
  mapAllSettled,
} from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  IS_TRON_TEST,
  REGISTRY_PATH,
  TEMP_PATH,
  getCombinedWarpDeployPath,
  getCombinedWarpRoutePath,
  getWarpRouteId,
} from '../consts.js';

import { deployOrUseExistingCore } from './core.js';
import {
  createSnapshot,
  deployAevoXERC20TokenOnChain,
  deployToken,
  deployXERC20LockboxToken,
  deployXERC20VSToken,
  getDeployedWarpAddress,
  localTestRunCmdPrefix,
  restoreSnapshot,
} from './helpers.js';
import {
  hyperlaneWarpApplyRaw,
  hyperlaneWarpCheckRaw,
  hyperlaneWarpDeploy,
  readWarpConfig,
} from './warp.js';

$.verbose = true;

describe('xerc20 e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses;
  let chain3Addresses: ChainAddresses;
  let originalChain3MetadataYaml: string | undefined;
  let ownerAddress: Address;

  let tokenChain2: ERC20Test;
  let xERC20Lockbox2: XERC20LockboxTest;
  let xERC20VS2: XERC20VSTest;
  let xERC20VS3: XERC20VSTest;
  let vsWarpRouteAddress2: Address | undefined;
  let vsWarpRouteAddress3: Address | undefined;

  const XERC20_LOCKBOX_DEPLOY_PATH = `${TEMP_PATH}/warp-xerc20-lockbox-deploy.yaml`;
  const XERC20_VS_DEPLOY_PATH = `${TEMP_PATH}/warp-xerc20-vs-deploy.yaml`;
  const XERC20_VS_CORE_PATH = getCombinedWarpRoutePath('XERC20VS', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);

  const XERC20_LOCKBOX_WARP_ROUTE_ID = getWarpRouteId('XERC20', [CHAIN_NAME_2]);
  const XERC20_VS_WARP_ROUTE_ID = getWarpRouteId('XERC20VS', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);
  const XERC20_VS_REGISTRY_DEPLOY_PATH = getCombinedWarpDeployPath('XERC20VS', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);

  before(async function () {
    originalChain3MetadataYaml = readFileSync(CHAIN_3_METADATA_PATH, 'utf8');
    const originalChain3Metadata: ChainMetadata = readYamlOrJson(
      CHAIN_3_METADATA_PATH,
    );
    writeYamlOrJson(CHAIN_3_METADATA_PATH, {
      ...originalChain3Metadata,
      blockExplorers: [],
    });

    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(
        CHAIN_NAME_2,
        './examples/core-config.yaml',
        ANVIL_KEY,
      ),
      deployOrUseExistingCore(
        CHAIN_NAME_3,
        './examples/core-config.yaml',
        ANVIL_KEY,
      ),
    ]);

    ownerAddress = new Wallet(ANVIL_KEY).address;

    tokenChain2 = await deployToken(ANVIL_KEY, CHAIN_NAME_2, 18, 'XERC20');
    xERC20Lockbox2 = await deployXERC20LockboxToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      tokenChain2,
    );

    xERC20VS2 = await deployXERC20VSToken(
      ANVIL_KEY,
      CHAIN_NAME_2,
      18,
      'XERC20VS',
    );
    xERC20VS3 = await deployXERC20VSToken(
      ANVIL_KEY,
      CHAIN_NAME_3,
      18,
      'XERC20VS',
    );
  });

  after(function () {
    if (originalChain3MetadataYaml) {
      writeFileSync(CHAIN_3_METADATA_PATH, originalChain3MetadataYaml);
    }
  });

  const BRIDGE_LIMITS = {
    bufferCap: '1000000000000000000000',
    rateLimitPerSecond: '1000000000000000000',
  };

  // xERC20VS tokens are shared across tests (deployed once in `before`), and the
  // owner-gated addBridge in every `beforeEach` reverts if ownership is stranded
  // on a throwaway wallet. Fund the current owner for gas and hand ownership back
  // to the deployer so subsequent tests keep working.
  async function restoreTokenOwnership(
    token: XERC20VSTest,
    currentOwnerWallet: Wallet,
  ): Promise<void> {
    // If the apply/assertion failed before the handoff landed, the deployer is
    // still the owner and there is nothing to restore.
    const currentOwner = await token.owner();
    if (currentOwner === ownerAddress) return;

    await token.signer
      .sendTransaction({
        to: currentOwnerWallet.address,
        value: utils.parseEther('1'),
      })
      .then((tx) => tx.wait());
    await token
      .connect(currentOwnerWallet)
      .transferOwnership(ownerAddress)
      .then((tx) => tx.wait());
  }

  async function deployWarpRoutesAndSetupBridges(): Promise<void> {
    vsWarpRouteAddress2 = undefined;
    vsWarpRouteAddress3 = undefined;

    const xerc20LockboxConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.XERC20Lockbox,
        token: xERC20Lockbox2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
    };
    writeYamlOrJson(XERC20_LOCKBOX_DEPLOY_PATH, xerc20LockboxConfig);
    await hyperlaneWarpDeploy(XERC20_LOCKBOX_DEPLOY_PATH, 'XERC20/anvil2');

    const xerc20VSConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.XERC20,
        token: xERC20VS2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.XERC20,
        token: xERC20VS3.address,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
      },
    };
    writeYamlOrJson(XERC20_VS_DEPLOY_PATH, xerc20VSConfig);
    await hyperlaneWarpDeploy(XERC20_VS_DEPLOY_PATH, 'XERC20VS/anvil2-anvil3');

    const xerc20VSCoreConfig: WarpCoreConfig =
      readYamlOrJson(XERC20_VS_CORE_PATH);
    vsWarpRouteAddress2 = xerc20VSCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_2,
    )?.addressOrDenom;
    vsWarpRouteAddress3 = xerc20VSCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_3,
    )?.addressOrDenom;

    assert(vsWarpRouteAddress2, `Missing warp route on ${CHAIN_NAME_2}`);
    assert(vsWarpRouteAddress3, `Missing warp route on ${CHAIN_NAME_3}`);

    await xERC20VS2
      .addBridge({ bridge: vsWarpRouteAddress2, ...BRIDGE_LIMITS })
      .then((tx) => tx.wait());
    await xERC20VS3
      .addBridge({ bridge: vsWarpRouteAddress3, ...BRIDGE_LIMITS })
      .then((tx) => tx.wait());

    const xerc20VSConfigWithLimits: WarpRouteDeployConfig = {
      [CHAIN_NAME_2]: {
        type: TokenType.XERC20,
        token: xERC20VS2.address,
        mailbox: chain2Addresses.mailbox,
        owner: ownerAddress,
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Velo,
            ...BRIDGE_LIMITS,
          },
        },
      },
      [CHAIN_NAME_3]: {
        type: TokenType.XERC20,
        token: xERC20VS3.address,
        mailbox: chain3Addresses.mailbox,
        owner: ownerAddress,
        xERC20: {
          warpRouteLimits: {
            type: XERC20Type.Velo,
            ...BRIDGE_LIMITS,
          },
        },
      },
    };
    writeYamlOrJson(XERC20_VS_DEPLOY_PATH, xerc20VSConfigWithLimits);
    // Also write to registry deploy path so --warp-route-id can resolve it
    writeYamlOrJson(XERC20_VS_REGISTRY_DEPLOY_PATH, xerc20VSConfigWithLimits);
  }

  beforeEach(async function () {
    await deployWarpRoutesAndSetupBridges();
  });

  afterEach(async function () {
    await Promise.all([
      vsWarpRouteAddress2
        ? xERC20VS2.removeBridge(vsWarpRouteAddress2).then((tx) => tx.wait())
        : Promise.resolve(),
      vsWarpRouteAddress3
        ? xERC20VS3.removeBridge(vsWarpRouteAddress3).then((tx) => tx.wait())
        : Promise.resolve(),
    ]);
  });

  describe('apply', function () {
    it('reports no updates when config matches on-chain state', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --chains ${CHAIN_NAME_2} \
        --key ${ANVIL_KEY} \
        --verbosity debug`;

      expect(result.stdout).to.include('No updates needed');
    });

    it('generates transactions when config specifies different limits', async function () {
      const configWithLimits: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.XERC20,
          token: xERC20VS2.address,
          mailbox: chain2Addresses.mailbox,
          owner: ownerAddress,
          xERC20: {
            warpRouteLimits: {
              type: XERC20Type.Velo,
              bufferCap: '2000000000000000000000',
              rateLimitPerSecond: '2000000000000000000',
            },
          },
        },
        [CHAIN_NAME_3]: {
          type: TokenType.XERC20,
          token: xERC20VS3.address,
          mailbox: chain3Addresses.mailbox,
          owner: ownerAddress,
          xERC20: {
            warpRouteLimits: {
              type: XERC20Type.Velo,
              bufferCap: '2000000000000000000000',
              rateLimitPerSecond: '2000000000000000000',
            },
          },
        },
      };
      writeYamlOrJson(XERC20_VS_REGISTRY_DEPLOY_PATH, configWithLimits);

      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --chains ${CHAIN_NAME_2} \
        --key ${ANVIL_KEY} \
        --verbosity debug`;

      expect(result.stdout).to.include('Generated');
    });

    it('applies to all chains when --chains is not specified', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --key ${ANVIL_KEY} \
        --verbosity debug`;

      expect(result.stdout).to.include(CHAIN_NAME_2);
      expect(result.stdout).to.include(CHAIN_NAME_3);
    });
  });

  describe('ownership transfer', function () {
    it('transfers XERC20 token ownership when config owner differs', async function () {
      const newOwnerWallet = Wallet.createRandom().connect(xERC20VS2.provider);
      const newOwner = newOwnerWallet.address;

      const configWithNewOwner: WarpRouteDeployConfig = {
        [CHAIN_NAME_2]: {
          type: TokenType.XERC20,
          token: xERC20VS2.address,
          mailbox: chain2Addresses.mailbox,
          owner: newOwner,
          xERC20: {
            warpRouteLimits: {
              type: XERC20Type.Velo,
              ...BRIDGE_LIMITS,
            },
          },
        },
      };
      writeYamlOrJson(XERC20_VS_REGISTRY_DEPLOY_PATH, configWithNewOwner);

      const ownerBefore = await xERC20VS2.owner();
      expect(ownerBefore).to.equal(ownerAddress);

      try {
        await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
          --registry ${REGISTRY_PATH} \
          --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
          --chains ${CHAIN_NAME_2} \
          --key ${ANVIL_KEY} \
          --verbosity debug`;

        const ownerAfter = await xERC20VS2.owner();
        expect(ownerAfter).to.equal(newOwner);
      } finally {
        // Runs even if the apply or assertion throws, so a failure here doesn't
        // strand ownership and cascade into every subsequent test's beforeEach.
        await restoreTokenOwnership(xERC20VS2, newOwnerWallet);
      }
    });

    it('reports no updates when token owner already matches config', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --chains ${CHAIN_NAME_2} \
        --key ${ANVIL_KEY} \
        --verbosity debug`;

      expect(result.stdout).to.include('No updates needed');
    });
  });

  describe('read', function () {
    it('displays the XERC20 token owner', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 read \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --chains ${CHAIN_NAME_2} \
        --verbosity debug`;

      expect(result.stdout).to.include(ownerAddress);
    });

    it('displays current limits for Velodrome XERC20', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 read \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --chains ${CHAIN_NAME_2} \
        --verbosity debug`;

      const output = result.stdout;
      expect(output).to.include('velo');
    });

    it('displays current limits for Standard XERC20', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 read \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_LOCKBOX_WARP_ROUTE_ID} \
        --verbosity debug`;

      const output = result.stdout;
      expect(output).to.include(CHAIN_NAME_2);
    });

    it('filters by chain when --chains is specified', async function () {
      const result = await $`${localTestRunCmdPrefix()} hyperlane xerc20 read \
        --registry ${REGISTRY_PATH} \
        --warp-route-id ${XERC20_VS_WARP_ROUTE_ID} \
        --chains ${CHAIN_NAME_2} \
        --verbosity debug`;

      const output = result.stdout;
      expect(output).to.include(CHAIN_NAME_2);
    });
  });

  describe('warp read', function () {
    // A bridge that is neither a lockbox nor the route's own router used to be
    // dropped from the derived config, which reported a token carrying extra
    // bridges as carrying none.
    it('reports an extra bridge that is not a lockbox', async function () {
      const extraBridge = tokenChain2.address;
      await xERC20VS2
        .addBridge({ bridge: extraBridge, ...BRIDGE_LIMITS })
        .then((tx) => tx.wait());

      try {
        const config = await readWarpConfig(
          CHAIN_NAME_2,
          XERC20_VS_CORE_PATH,
          `${TEMP_PATH}/xerc20-vs-extra-bridge-read.yaml`,
        );

        const chainConfig = config[CHAIN_NAME_2];
        assert(
          isXERC20TokenConfig(chainConfig),
          `Expected an xERC20 config for ${CHAIN_NAME_2}`,
        );
        expect(chainConfig.xERC20?.extraBridges).to.deep.equal([
          {
            lockbox: extraBridge,
            limits: { type: XERC20Type.Velo, ...BRIDGE_LIMITS },
          },
        ]);
      } finally {
        // The token is deployed once for the whole suite, so a bridge left
        // behind would make the later apply runs emit a removeBridge.
        await xERC20VS2.removeBridge(extraBridge).then((tx) => tx.wait());
      }
    });
  });
});

const AEVO_TOKEN_INTERFACE = new utils.Interface(XERC20_AEVO_ABI);

// The selectors as they appear in the bytecode of the token, written out here
// so a wrong signature in the ABI of the SDK cannot agree with itself.
const AEVO_SELECTORS = {
  authorities: '0x91223d69',
  caps: '0x66d97b21',
  updateAuthority: '0x6cd22eaf',
  setCap: '0x80ad2cf3',
  owner: '0x8da5cb5b',
  setOwner: '0x13af4035',
};

// A call to the token as [name, ...args], the args as strings.
type AevoCall = string[];

const aevoRaw = (value: string): AevoXERC20Limits => ({
  type: XERC20Type.Aevo,
  authorized: true,
  cap: { type: XERC20AevoCapType.Raw, value },
});
const aevoUnlimited = (): AevoXERC20Limits => ({
  type: XERC20Type.Aevo,
  authorized: true,
  cap: { type: XERC20AevoCapType.Unlimited },
});
const aevoUnauthorized = (): AevoXERC20Limits => ({
  type: XERC20Type.Aevo,
  authorized: false,
});

// Above 2^53, and not representable as a double: a cap that went through a
// number would not come back as the cap that was declared.
const CAP_ABOVE_2_POW_53 = '123456789012345678901';
// The same cap spelled with leading zeros, which the schema reads as the cap
// above, so what the registry holds after a deploy is not what was declared.
const CAP_ABOVE_2_POW_53_AS_DECLARED = '000123456789012345678901';
const CAP_JUST_ABOVE_2_POW_53 = '9007199254740993';

// An xERC20 route holds xERC20 and collateral tokens only, so the Aevo token on
// anvil2 is paired with a collateral token on anvil3.
describe('xerc20 Aevo e2e tests', function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  const AEVO_WARP_ROUTE_ID = getWarpRouteId('USDC', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);
  const AEVO_REGISTRY_DEPLOY_PATH = getCombinedWarpDeployPath('USDC', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);
  const AEVO_REGISTRY_CORE_PATH = getCombinedWarpRoutePath('USDC', [
    CHAIN_NAME_2,
    CHAIN_NAME_3,
  ]);
  const AEVO_DEPLOY_PATH = `${TEMP_PATH}/warp-xerc20-aevo-deploy.yaml`;
  const AEVO_READ_PATH = `${TEMP_PATH}/warp-xerc20-aevo-read.yaml`;
  const AEVO_RECEIPTS_DIR = `${TEMP_PATH}/warp-xerc20-aevo-receipts`;

  let chain2Addresses: ChainAddresses;
  let chain3Addresses: ChainAddresses;
  let rpcUrl2: string;
  let rpcUrl3: string;
  let provider2: providers.JsonRpcProvider;
  let deployer: Wallet;
  let collateral: ERC20Test;
  let aevoToken: Contract;

  // The snapshots of a chain. The suite one is taken before the fixtures are
  // deployed and is reverted once, in `after`, which puts the chain as it was
  // found. The test one is taken after them, and again before each test, right
  // after the revert that consumed the last. Each is undefined where there is
  // none to revert to, and the ID of one a revert was tried with is not tried
  // again, so that a chain whose revert failed is not sent one that may be
  // consumed.
  interface ChainSnapshots {
    rpcUrl: string;
    suite?: string;
    test?: string;
  }
  let chainSnapshots: ChainSnapshots[] = [];

  // Runs the task for every chain, each to its end, and fails with every chain
  // that failed and why, so that one that fails neither leaves the others
  // unfinished nor hides what went wrong.
  async function forEveryChain(task: (chain: ChainSnapshots) => Promise<void>) {
    const { rejected } = await mapAllSettled(
      chainSnapshots,
      task,
      (chain) => chain.rpcUrl,
    );
    if (rejected.size > 0) {
      const failures = [...rejected].map(
        ([rpcUrl, error]) => `${rpcUrl}: ${error.message}`,
      );
      throw new Error(`Failed on ${failures.join('; ')}`);
    }
  }

  async function revertToTestSnapshot(chain: ChainSnapshots) {
    const id = chain.test;
    assert(!isNullish(id), `Missing the test snapshot of ${chain.rpcUrl}`);
    chain.test = undefined;
    await restoreSnapshot(chain.rpcUrl, id);
    chain.test = await createSnapshot(chain.rpcUrl);
  }

  async function revertToSuiteSnapshot(chain: ChainSnapshots) {
    const id = chain.suite;
    if (isNullish(id)) return;
    chain.suite = undefined;
    await restoreSnapshot(chain.rpcUrl, id);
  }

  before(async function () {
    if (IS_TRON_TEST) this.skip();

    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(
        CHAIN_NAME_2,
        './examples/core-config.yaml',
        ANVIL_KEY,
      ),
      deployOrUseExistingCore(
        CHAIN_NAME_3,
        './examples/core-config.yaml',
        ANVIL_KEY,
      ),
    ]);

    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);
    rpcUrl2 = chain2Metadata.rpcUrls[0].http;
    rpcUrl3 = chain3Metadata.rpcUrls[0].http;
    provider2 = new providers.JsonRpcProvider(rpcUrl2);
    deployer = new Wallet(ANVIL_KEY, provider2);

    // anvil keeps its state between runs, so the chains are left as they are
    // before the fixtures below.
    chainSnapshots = [{ rpcUrl: rpcUrl2 }, { rpcUrl: rpcUrl3 }];
    await forEveryChain(async (chain) => {
      chain.suite = await createSnapshot(chain.rpcUrl);
    });

    collateral = await deployToken(ANVIL_KEY, CHAIN_NAME_3, 6, 'USDC');
    const deployedToken = await deployAevoXERC20TokenOnChain(
      ANVIL_KEY,
      CHAIN_NAME_2,
    );
    aevoToken = new Contract(
      deployedToken.address,
      AEVO_TOKEN_INTERFACE,
      provider2,
    );

    await forEveryChain(async (chain) => {
      chain.test = await createSnapshot(chain.rpcUrl);
    });
  });

  // The token owner, its caps and every route a test deploys go back to what
  // they were after the setup above. The route files of the registry are reset
  // before each test by the root `beforeEach` of e2e-test.setup.ts.
  beforeEach(async function () {
    await forEveryChain(revertToTestSnapshot);
  });

  // The suite snapshots are older than the test ones, so reverting them takes
  // the chains back past the fixtures as well.
  after(async function () {
    await forEveryChain(revertToSuiteSnapshot);
  });

  function expectSameAddress(actual: Address, expected: Address) {
    expect(
      eqAddress(actual, expected),
      `expected ${expected}, found ${actual}`,
    ).to.equal(true);
  }

  // What the token itself holds for a minter, as it keeps it.
  async function mintAuthority(minter: Address) {
    return {
      authorized: await aevoToken.authorities(minter),
      cap: (await aevoToken.caps(minter)).toString(),
    };
  }

  async function routerOwner(router: Address): Promise<Address> {
    return new Contract(
      router,
      ['function owner() view returns (address)'],
      provider2,
    ).owner();
  }

  // Asked of the node itself: a provider never reports a block number below
  // the highest it has seen, which a reverted snapshot leaves behind.
  async function currentBlock(): Promise<number> {
    return Number(await provider2.send('eth_blockNumber', []));
  }

  // The calls to the token mined after a block, in the order they were mined.
  async function tokenCallsSince(fromBlock: number): Promise<AevoCall[]> {
    const calls: AevoCall[] = [];
    const latest = await currentBlock();
    for (let number = fromBlock + 1; number <= latest; number++) {
      const block = await provider2.getBlockWithTransactions(number);
      for (const tx of block.transactions) {
        if (isNullish(tx.to) || !eqAddress(tx.to, aevoToken.address)) continue;
        const call = AEVO_TOKEN_INTERFACE.parseTransaction({ data: tx.data });
        calls.push([call.name, ...call.args.map(String)]);
      }
    }
    return calls;
  }

  function aevoDeployConfig(
    limits?: AevoXERC20Limits,
    owner: Address = deployer.address,
  ): WarpRouteDeployConfig {
    return {
      [CHAIN_NAME_2]: {
        type: TokenType.XERC20,
        token: aevoToken.address,
        mailbox: chain2Addresses.mailbox,
        owner,
        xERC20: isNullish(limits) ? undefined : { warpRouteLimits: limits },
      },
      [CHAIN_NAME_3]: {
        type: TokenType.collateral,
        token: collateral.address,
        mailbox: chain3Addresses.mailbox,
        owner,
      },
    };
  }

  // The deploy writes the route to the registry, as the CLI does for a user.
  async function deployRoute(limits?: AevoXERC20Limits): Promise<Address> {
    writeYamlOrJson(AEVO_DEPLOY_PATH, aevoDeployConfig(limits));
    await hyperlaneWarpDeploy(AEVO_DEPLOY_PATH, AEVO_WARP_ROUTE_ID);
    return getDeployedWarpAddress(CHAIN_NAME_2, AEVO_REGISTRY_CORE_PATH);
  }

  // The registry entry as the deploy left it, read through the file only.
  function registryLimits() {
    const config: WarpRouteDeployConfig = readYamlOrJson(
      AEVO_REGISTRY_DEPLOY_PATH,
    );
    const chainConfig = config[CHAIN_NAME_2];
    assert(
      chainConfig.type === TokenType.XERC20,
      `Expected an xERC20 config for ${CHAIN_NAME_2}`,
    );
    return chainConfig.xERC20?.warpRouteLimits;
  }

  function applyRoute() {
    return hyperlaneWarpApplyRaw({
      warpRouteId: AEVO_WARP_ROUTE_ID,
      receiptsDir: AEVO_RECEIPTS_DIR,
    });
  }

  async function expectCleanCheck() {
    const output = await hyperlaneWarpCheckRaw({
      warpRouteId: AEVO_WARP_ROUTE_ID,
    }).nothrow();

    expect(output.exitCode, output.stderr).to.equal(0);
    expect(output.text()).to.include('No violations found');
  }

  async function readRouterLimits() {
    const config = await readWarpConfig(
      CHAIN_NAME_2,
      AEVO_REGISTRY_CORE_PATH,
      AEVO_READ_PATH,
      { preserveExistingChains: false },
    );
    const chainConfig = config[CHAIN_NAME_2];
    assert(
      isXERC20TokenConfig(chainConfig),
      `Expected an xERC20 config for ${CHAIN_NAME_2}`,
    );
    return chainConfig.xERC20?.warpRouteLimits;
  }

  function applyXERC20() {
    return $`${localTestRunCmdPrefix()} hyperlane xerc20 apply \
      --registry ${REGISTRY_PATH} \
      --warp-route-id ${AEVO_WARP_ROUTE_ID} \
      --chains ${CHAIN_NAME_2} \
      --key ${ANVIL_KEY} \
      --receipts ${AEVO_RECEIPTS_DIR} \
      --verbosity debug`;
  }

  describe('the token', function () {
    it('has the selectors of the recorded token', function () {
      for (const [name, selector] of Object.entries(AEVO_SELECTORS)) {
        expect(AEVO_TOKEN_INTERFACE.getSighash(name)).to.equal(selector);
      }
    });

    it('is left as it is when it is deployed again', async function () {
      const fromBlock = await currentBlock();

      const deployed = await deployAevoXERC20TokenOnChain(
        ANVIL_KEY,
        CHAIN_NAME_2,
      );

      expectSameAddress(deployed.owner, deployer.address);
      expectSameAddress(await aevoToken.owner(), deployer.address);
      expect(await tokenCallsSince(fromBlock)).to.deep.equal([]);
    });

    it('is taken back from an owner that is not the deployer', async function () {
      const stale = randomAddress();
      await (await aevoToken.connect(deployer).setOwner(stale)).wait();
      expectSameAddress(await aevoToken.owner(), stale);

      await deployAevoXERC20TokenOnChain(ANVIL_KEY, CHAIN_NAME_2);

      expectSameAddress(await aevoToken.owner(), deployer.address);
    });
  });

  describe('warp deploy, warp check, warp apply and warp read', function () {
    interface Case {
      name: string;
      declared: AevoXERC20Limits;
      // What the deploy writes to the registry for what was declared.
      written: AevoXERC20Limits;
      driftBeforeApply: boolean;
      calls: (router: Address) => AevoCall[];
      onChain: { authorized: boolean; cap: string };
    }

    const cases: Case[] = [
      {
        name: 'a cap above 2^53',
        declared: aevoRaw(CAP_ABOVE_2_POW_53_AS_DECLARED),
        written: aevoRaw(CAP_ABOVE_2_POW_53),
        driftBeforeApply: true,
        calls: (router) => [
          ['setCap', router, CAP_ABOVE_2_POW_53],
          ['updateAuthority', router, 'true'],
        ],
        onChain: { authorized: true, cap: CAP_ABOVE_2_POW_53 },
      },
      {
        name: 'an unlimited cap',
        declared: aevoUnlimited(),
        written: aevoUnlimited(),
        driftBeforeApply: true,
        calls: (router) => [
          ['setCap', router, '0'],
          ['updateAuthority', router, 'true'],
        ],
        onChain: { authorized: true, cap: '0' },
      },
      {
        name: 'a router that is not authorized',
        declared: aevoUnauthorized(),
        written: aevoUnauthorized(),
        driftBeforeApply: false,
        calls: () => [],
        onChain: { authorized: false, cap: '0' },
      },
    ];

    for (const c of cases) {
      it(`loads what the deploy wrote for ${c.name}, applies it and reads it back`, async function () {
        const router = await deployRoute(c.declared);

        // The deploy parsed the declared limits and wrote what it parsed.
        const written = registryLimits();
        expect(written).to.deep.equal(c.written);
        if (
          written?.type === XERC20Type.Aevo &&
          written.authorized &&
          written.cap.type === XERC20AevoCapType.Raw
        ) {
          expect(typeof written.cap.value).to.equal('string');
        }

        // The deploy leaves the router unauthorized. The check loads the
        // registry entry the deploy wrote.
        const drift = await hyperlaneWarpCheckRaw({
          warpRouteId: AEVO_WARP_ROUTE_ID,
        }).nothrow();
        if (c.driftBeforeApply) {
          expect(drift.exitCode, drift.stderr).to.equal(1);
          expect(drift.text()).to.include('warpRouteLimits');
        } else {
          expect(drift.exitCode, drift.stderr).to.equal(0);
          expect(drift.text()).to.include('No violations found');
        }

        const fromBlock = await currentBlock();
        await applyRoute();

        expect(await tokenCallsSince(fromBlock)).to.deep.equal(
          c.calls(utils.getAddress(router)),
        );
        expect(await mintAuthority(router)).to.deep.equal(c.onChain);
        await expectCleanCheck();
        expect(await readRouterLimits()).to.deep.equal(c.written);
      });
    }
  });

  describe('warp apply', function () {
    it('moves a route through every state of its limits, each one a clean check and the same state a no-op', async function () {
      this.timeout(3 * DEFAULT_E2E_TEST_TIMEOUT);

      interface Step {
        name: string;
        limits: AevoXERC20Limits;
        calls: (router: Address) => AevoCall[];
        onChain: { authorized: boolean; cap: string };
      }

      const steps: Step[] = [
        {
          name: 'authorizes the router with a cap',
          limits: aevoRaw(CAP_ABOVE_2_POW_53),
          calls: (router) => [
            ['setCap', router, CAP_ABOVE_2_POW_53],
            ['updateAuthority', router, 'true'],
          ],
          onChain: { authorized: true, cap: CAP_ABOVE_2_POW_53 },
        },
        {
          name: 'leaves the router without a bound',
          limits: aevoUnlimited(),
          calls: (router) => [['setCap', router, '0']],
          onChain: { authorized: true, cap: '0' },
        },
        {
          name: 'binds the router just above 2^53',
          limits: aevoRaw(CAP_JUST_ABOVE_2_POW_53),
          calls: (router) => [['setCap', router, CAP_JUST_ABOVE_2_POW_53]],
          onChain: { authorized: true, cap: CAP_JUST_ABOVE_2_POW_53 },
        },
        {
          name: 'revokes the router and leaves its cap',
          limits: aevoUnauthorized(),
          calls: (router) => [['updateAuthority', router, 'false']],
          onChain: { authorized: false, cap: CAP_JUST_ABOVE_2_POW_53 },
        },
        {
          name: 'leaves a router that is already revoked alone',
          limits: aevoUnauthorized(),
          calls: () => [],
          onChain: { authorized: false, cap: CAP_JUST_ABOVE_2_POW_53 },
        },
        {
          name: 'authorizes it again without a bound, setting its cap along with it',
          limits: aevoUnlimited(),
          calls: (router) => [
            ['setCap', router, '0'],
            ['updateAuthority', router, 'true'],
          ],
          onChain: { authorized: true, cap: '0' },
        },
      ];

      const router = await deployRoute(aevoUnauthorized());

      for (const step of steps) {
        writeYamlOrJson(
          AEVO_REGISTRY_DEPLOY_PATH,
          aevoDeployConfig(step.limits),
        );
        const fromBlock = await currentBlock();

        const output = await applyRoute();

        const expectedCalls = step.calls(utils.getAddress(router));
        expect(await tokenCallsSince(fromBlock), step.name).to.deep.equal(
          expectedCalls,
        );
        expect(await mintAuthority(router), step.name).to.deep.equal(
          step.onChain,
        );
        if (expectedCalls.length === 0) {
          expect(output.text(), step.name).to.include(
            'Warp config is the same as target. No updates needed.',
          );
        }
        await expectCleanCheck();
      }
    });

    it('leaves the token alone for a deploy config that declares no limits, and reports what it holds as drift', async function () {
      const router = await deployRoute(aevoRaw(CAP_ABOVE_2_POW_53));
      await applyRoute();
      writeYamlOrJson(AEVO_REGISTRY_DEPLOY_PATH, aevoDeployConfig());

      const drift = await hyperlaneWarpCheckRaw({
        warpRouteId: AEVO_WARP_ROUTE_ID,
      }).nothrow();
      expect(drift.exitCode, drift.stderr).to.equal(1);
      expect(drift.text()).to.include('type: aevo');
      expect(drift.text()).to.include(`value: "${CAP_ABOVE_2_POW_53}"`);
      expect(drift.text()).to.include('EXPECTED: ""');

      const fromBlock = await currentBlock();
      const output = await applyRoute();

      expect(output.text()).to.include(
        'Warp config is the same as target. No updates needed.',
      );
      expect(await tokenCallsSince(fromBlock)).to.deep.equal([]);
      expect(await mintAuthority(router)).to.deep.equal({
        authorized: true,
        cap: CAP_ABOVE_2_POW_53,
      });
    });
  });

  describe('xerc20 apply', function () {
    it('hands the token over only through xerc20 apply, after warp apply left it with its owner', async function () {
      const router = await deployRoute(aevoRaw(CAP_ABOVE_2_POW_53));
      await applyRoute();
      const newOwner = randomAddress();
      const newCap = '987654321098765432109';
      writeYamlOrJson(
        AEVO_REGISTRY_DEPLOY_PATH,
        aevoDeployConfig(aevoRaw(newCap), newOwner),
      );

      let fromBlock = await currentBlock();
      await applyRoute();

      expect(await tokenCallsSince(fromBlock)).to.deep.equal([
        ['setCap', utils.getAddress(router), newCap],
      ]);
      expectSameAddress(await aevoToken.owner(), deployer.address);
      expectSameAddress(await routerOwner(router), newOwner);

      fromBlock = await currentBlock();
      const handover = await applyXERC20();

      expect(handover.stdout).to.include(
        `Generated 1 transaction(s) for ${CHAIN_NAME_2}`,
      );
      expect(handover.stdout).to.not.include('Failed for');
      expect(await tokenCallsSince(fromBlock)).to.deep.equal([
        ['setOwner', utils.getAddress(newOwner)],
      ]);
      expectSameAddress(await aevoToken.owner(), newOwner);

      fromBlock = await currentBlock();
      const again = await applyXERC20();

      expect(again.stdout).to.include(
        `${CHAIN_NAME_2}: XERC20 config already matches on-chain state`,
      );
      expect(again.stdout).to.not.include('Failed for');
      expect(await tokenCallsSince(fromBlock)).to.deep.equal([]);
      await expectCleanCheck();
    });

    it('refuses an expected owner of the zero address, which the token cannot be renounced to', async function () {
      await deployRoute(aevoRaw(CAP_ABOVE_2_POW_53));
      await applyRoute();
      writeYamlOrJson(
        AEVO_REGISTRY_DEPLOY_PATH,
        aevoDeployConfig(aevoRaw(CAP_ABOVE_2_POW_53), constants.AddressZero),
      );
      const fromBlock = await currentBlock();

      const refused = await applyXERC20();

      expect(refused.stdout).to.include(`Failed for ${CHAIN_NAME_2}`);
      expect(refused.stdout).to.include('whose ownership cannot be renounced');
      expect(await tokenCallsSince(fromBlock)).to.deep.equal([]);
      expectSameAddress(await aevoToken.owner(), deployer.address);
    });
  });
});
