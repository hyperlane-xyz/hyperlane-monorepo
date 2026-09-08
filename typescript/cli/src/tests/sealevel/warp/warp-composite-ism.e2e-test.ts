import { expect } from 'chai';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import { SealevelSigner, createRpc } from '@hyperlane-xyz/sealevel-sdk';
import { airdropSol } from '@hyperlane-xyz/sealevel-sdk/testing';
import {
  type CompositeIsmNodeConfig,
  CompositeIsmNodeType,
  IsmType,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
import { syncWarpDeployConfigToRegistry } from '../../commands/warp-config-sync.js';
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  CORE_ADDRESSES_PATH_BY_PROTOCOL,
  CORE_CONFIG_PATH_BY_PROTOCOL,
  CORE_READ_CONFIG_PATH_BY_PROTOCOL,
  HYP_KEY_BY_PROTOCOL,
  REGISTRY_PATH,
  TEMP_PATH,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
  getWarpCoreConfigPath,
} from '../../constants.js';

const CHAIN_NAME = 'svmlocal1';
const REMOTE_CHAIN_NAME = 'anvil1';
const SVM_KEY = HYP_KEY_BY_PROTOCOL.sealevel;
const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/svm-composite-ism-deploy.yaml`;

// Each composite ISM is its own on-chain program, so this suite pays for
// several program deploys on top of the warp routers themselves.
const SVM_COMPOSITE_ISM_TIMEOUT = 600_000;

const MAX_CAPACITY = '86400';

const shortHexToBytes32 = (value: string) => `0x${value.padStart(64, '0')}`;

// A syntactically valid H256 that is not any router deployed here.
const WRONG_RECIPIENT = shortHexToBytes32('beef');

// Included in the deploy config to prove ISM deferral preserves unrelated
// router and gas configuration.
const REMOTE_ROUTER_ADDRESS = shortHexToBytes32('cafe');
const REMOTE_DESTINATION_GAS = '200000';

function rateLimitedNode(
  mailbox: string,
  recipient?: string,
): CompositeIsmNodeConfig {
  return recipient === undefined
    ? {
        type: CompositeIsmNodeType.RATE_LIMITED,
        maxCapacity: MAX_CAPACITY,
        mailbox,
      }
    : {
        type: CompositeIsmNodeType.RATE_LIMITED,
        maxCapacity: MAX_CAPACITY,
        mailbox,
        recipient,
      };
}

function expectedRecipient(routerAddress: string): string {
  return addressToBytes32(routerAddress, ProtocolType.Sealevel).toLowerCase();
}

/** Narrows a read-back warp config down to its composite ISM root node. */
function readCompositeIsmRoot(
  config: WarpRouteDeployConfig,
): CompositeIsmNodeConfig {
  const chainConfig = config[CHAIN_NAME];
  assert(chainConfig, `Expected a config entry for ${CHAIN_NAME}`);
  const ism = chainConfig.interchainSecurityModule;
  assert(
    ism && typeof ism !== 'string',
    'Expected an expanded ISM config, not an address reference',
  );
  assert(
    ism.type === IsmType.COMPOSITE,
    `Expected a ${IsmType.COMPOSITE}, got ${ism.type}`,
  );
  return ism.root;
}

describe('hyperlane warp composite ISM rateLimited recipient CLI e2e tests (Sealevel)', function () {
  this.timeout(SVM_COMPOSITE_ISM_TIMEOUT);

  let signer: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;
  let mailboxAddress: string;
  let rpc: ReturnType<typeof createRpc>;

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/svm-composite-ism-read.yaml`,
  );

  before(async function () {
    const rpcUrl = TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl;
    rpc = createRpc(rpcUrl);
    signer = await SealevelSigner.connectWithSigner(
      TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      SVM_KEY,
    );

    await airdropSol(rpc, signer.getSignerAddress(), 50_000_000_000n);

    const hyperlaneCore = new HyperlaneE2ECoreTestCommands(
      ProtocolType.Sealevel,
      CHAIN_NAME,
      REGISTRY_PATH,
      CORE_CONFIG_PATH_BY_PROTOCOL.sealevel,
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );

    const coreConfig = readYamlOrJson(CORE_CONFIG_PATH_BY_PROTOCOL.sealevel);
    writeYamlOrJson(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
      coreConfig,
    );
    hyperlaneCore.setCoreInputPath(
      CORE_READ_CONFIG_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );
    await hyperlaneCore.deploy(SVM_KEY);

    const coreAddresses: ChainAddresses = readYamlOrJson(
      CORE_ADDRESSES_PATH_BY_PROTOCOL.sealevel.CHAIN_NAME_1,
    );
    mailboxAddress = coreAddresses.mailbox;
  });

  describe('warp deploy', function () {
    const SYMBOL = 'CIRL';
    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);

    it('deploys, resolves the recipient, and preserves the remaining config', async function () {
      const ownerAddress = signer.getSignerAddress();
      const deployConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME]: {
          type: TokenType.native,
          name: 'Composite Rate Limited Token',
          symbol: SYMBOL,
          decimals: 9,
          mailbox: mailboxAddress,
          owner: ownerAddress,
          remoteRouters: {
            [REMOTE_CHAIN_NAME]: { address: REMOTE_ROUTER_ADDRESS },
          },
          destinationGas: {
            [REMOTE_CHAIN_NAME]: REMOTE_DESTINATION_GAS,
          },
          interchainSecurityModule: {
            type: IsmType.COMPOSITE,
            owner: ownerAddress,
            root: {
              type: CompositeIsmNodeType.AGGREGATION,
              threshold: 1,
              subIsms: [
                { type: CompositeIsmNodeType.TEST, accept: true },
                rateLimitedNode(mailboxAddress),
              ],
            },
          },
        },
      };
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, deployConfig);

      await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);
      const routerAddress = warpCommands.getDeployedWarpAddress(
        CHAIN_NAME,
        warpCorePath,
      );
      const readConfig = await warpCommands.readConfig(
        CHAIN_NAME,
        warpCorePath,
      );
      const root = readCompositeIsmRoot(readConfig);
      assert(
        root.type === CompositeIsmNodeType.AGGREGATION,
        `Expected an aggregation root, got ${root.type}`,
      );
      const node = root.subIsms[1];
      assert(
        node.type === CompositeIsmNodeType.RATE_LIMITED,
        `Expected a rateLimited sub-ISM, got ${node.type}`,
      );
      expect(node.recipient).to.equal(expectedRecipient(routerAddress));
      expect(node.maxCapacity).to.equal(MAX_CAPACITY);
      expect(node.mailbox).to.equal(mailboxAddress);
      expect(
        readConfig[CHAIN_NAME].remoteRouters?.[REMOTE_CHAIN_NAME],
      ).to.deep.equal({ address: REMOTE_ROUTER_ADDRESS });
      expect(
        readConfig[CHAIN_NAME].destinationGas?.[REMOTE_CHAIN_NAME],
      ).to.equal(REMOTE_DESTINATION_GAS);

      const checkOutput = await warpCommands
        .checkRaw({ warpRouteId })
        .nothrow();
      expect(checkOutput.exitCode).to.equal(0);

      const reapplyConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME]: {
          ...deployConfig[CHAIN_NAME],
          ...readConfig[CHAIN_NAME],
        },
      };
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, reapplyConfig);
      syncWarpDeployConfigToRegistry({
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        warpRouteId,
        registryPath: REGISTRY_PATH,
      });

      const applyOutput = await warpCommands
        .applyRaw({
          warpRouteId,
          privateKey: SVM_KEY,
          skipConfirmationPrompts: true,
        })
        .nothrow();
      expect(applyOutput.exitCode).to.equal(0);
      expect(applyOutput.stdout).to.include(
        'Warp config is the same as target. No updates needed.',
      );

      const afterApply = await warpCommands.readConfig(
        CHAIN_NAME,
        warpCorePath,
      );
      const afterRoot = readCompositeIsmRoot(afterApply);
      assert(
        afterRoot.type === CompositeIsmNodeType.AGGREGATION,
        `Expected an aggregation root, got ${afterRoot.type}`,
      );
      const afterNode = afterRoot.subIsms[1];
      assert(
        afterNode.type === CompositeIsmNodeType.RATE_LIMITED,
        `Expected a rateLimited sub-ISM, got ${afterNode.type}`,
      );
      expect(afterNode.recipient).to.equal(expectedRecipient(routerAddress));
    });

    it('rejects a hand-written recipient on deploy', async function () {
      const REJECT_SYMBOL = 'CIRLBAD';
      const rejectRouteId = createWarpRouteConfigId(REJECT_SYMBOL, CHAIN_NAME);
      const ownerAddress = signer.getSignerAddress();
      const rejectConfig: WarpRouteDeployConfig = {
        [CHAIN_NAME]: {
          type: TokenType.native,
          name: 'Composite Rate Limited Reject Token',
          symbol: REJECT_SYMBOL,
          decimals: 9,
          mailbox: mailboxAddress,
          owner: ownerAddress,
          interchainSecurityModule: {
            type: IsmType.COMPOSITE,
            owner: ownerAddress,
            root: rateLimitedNode(mailboxAddress, WRONG_RECIPIENT),
          },
        },
      };
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, rejectConfig);

      const output = await warpCommands
        .deployRaw({
          privateKey: SVM_KEY,
          skipConfirmationPrompts: true,
          warpRouteId: rejectRouteId,
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
        })
        .nothrow();

      expect(output.exitCode).to.not.equal(0);
      expect(`${output.stdout}${output.stderr}`).to.include(
        'rateLimited.recipient must not be set when deploying a new warp route',
      );
    });
  });

  describe('warp apply', function () {
    const SYMBOL = 'CIRLAT';
    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);

    it('attaches, validates, and updates contextual composite ISMs', async function () {
      const ownerAddress = signer.getSignerAddress();
      const baseConfig: WarpRouteDeployConfig[string] = {
        type: TokenType.native,
        name: 'Composite Rate Limited Apply Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
      };
      writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, { [CHAIN_NAME]: baseConfig });

      await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);
      const routerAddress = warpCommands.getDeployedWarpAddress(
        CHAIN_NAME,
        warpCorePath,
      );
      const applyIsm = (root: CompositeIsmNodeConfig) => {
        const config: WarpRouteDeployConfig = {
          [CHAIN_NAME]: {
            ...baseConfig,
            interchainSecurityModule: {
              type: IsmType.COMPOSITE,
              owner: signer.getSignerAddress(),
              root,
            },
          },
        };
        writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, config);
        syncWarpDeployConfigToRegistry({
          warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
          warpRouteId,
          registryPath: REGISTRY_PATH,
        });
        return warpCommands
          .applyRaw({
            warpRouteId,
            privateKey: SVM_KEY,
            skipConfirmationPrompts: true,
          })
          .nothrow();
      };

      const attachOutput = await applyIsm(
        rateLimitedNode(mailboxAddress, expectedRecipient(routerAddress)),
      );
      expect(attachOutput.exitCode).to.equal(0);

      const attachedConfig = await warpCommands.readConfig(
        CHAIN_NAME,
        warpCorePath,
      );
      const attachedRoot = readCompositeIsmRoot(attachedConfig);
      assert(
        attachedRoot.type === CompositeIsmNodeType.RATE_LIMITED,
        `Expected a rateLimited root, got ${attachedRoot.type}`,
      );
      expect(attachedRoot.recipient).to.equal(expectedRecipient(routerAddress));

      const mismatchOutput = await applyIsm(
        rateLimitedNode(mailboxAddress, WRONG_RECIPIENT),
      );

      expect(mismatchOutput.exitCode).to.not.equal(0);
      expect(`${mismatchOutput.stdout}${mismatchOutput.stderr}`).to.include(
        'does not match the warp router it protects',
      );

      const routingOutput = await applyIsm({
        type: CompositeIsmNodeType.ROUTING,
        domains: {
          [REMOTE_CHAIN_NAME]: rateLimitedNode(mailboxAddress),
        },
      });
      expect(routingOutput.exitCode).to.equal(0);

      const routingConfig = await warpCommands.readConfig(
        CHAIN_NAME,
        warpCorePath,
      );
      const routingRoot = readCompositeIsmRoot(routingConfig);
      assert(
        routingRoot.type === CompositeIsmNodeType.ROUTING,
        `Expected a routing root, got ${routingRoot.type}`,
      );
      const domainNode = routingRoot.domains?.[REMOTE_CHAIN_NAME];
      assert(domainNode, `Expected a domain override for ${REMOTE_CHAIN_NAME}`);
      assert(
        domainNode.type === CompositeIsmNodeType.RATE_LIMITED,
        `Expected a rateLimited domain override, got ${domainNode.type}`,
      );
      expect(domainNode.recipient).to.equal(expectedRecipient(routerAddress));
    });
  });
});
