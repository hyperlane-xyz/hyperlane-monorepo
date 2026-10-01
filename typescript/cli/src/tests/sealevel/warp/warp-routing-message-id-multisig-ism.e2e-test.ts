import { expect } from 'chai';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import { SealevelSigner, createRpc } from '@hyperlane-xyz/sealevel-sdk';
import { airdropSol } from '@hyperlane-xyz/sealevel-sdk/testing';
import {
  IsmType,
  type RoutingMessageIdMultisigIsmConfig,
  TokenType,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, assert } from '@hyperlane-xyz/utils';

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
const DOMAIN_A = 'anvil1';
const DOMAIN_B = 'anvil2';
const DOMAIN_C = 'anvil3';
const SVM_KEY = HYP_KEY_BY_PROTOCOL.sealevel;
const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/svm-routing-message-id-multisig-ism-deploy.yaml`;

// Each ISM is its own on-chain program, so the suite pays for a program
// deploy on top of the warp router, and again for every redeploy.
const SVM_ROUTING_ISM_TIMEOUT = 900_000;

// Digit-only so casing can never differ between config and read-back.
const validator = (digit: string) => `0x${digit.repeat(40)}`;
const VALIDATOR_1 = validator('1');
const VALIDATOR_2 = validator('2');
const VALIDATOR_3 = validator('3');
const VALIDATOR_4 = validator('4');
const VALIDATOR_5 = validator('5');

const NO_UPDATES_MESSAGE =
  'Warp config is the same as target. No updates needed.';

type Domains = RoutingMessageIdMultisigIsmConfig['domains'];

const INITIAL_DOMAINS: Domains = {
  [DOMAIN_A]: { validators: [VALIDATOR_1, VALIDATOR_2], threshold: 2 },
  [DOMAIN_B]: { validators: [VALIDATOR_3], threshold: 1 },
};

// DOMAIN_A changed in place and DOMAIN_C added; DOMAIN_B unchanged.
const UPDATED_DOMAINS: Domains = {
  [DOMAIN_A]: { validators: [VALIDATOR_4], threshold: 1 },
  [DOMAIN_B]: { validators: [VALIDATOR_3], threshold: 1 },
  [DOMAIN_C]: { validators: [VALIDATOR_1, VALIDATOR_5], threshold: 1 },
};

// DOMAIN_B dropped: the program has no remove-domain instruction.
const REDUCED_DOMAINS: Domains = {
  [DOMAIN_A]: UPDATED_DOMAINS[DOMAIN_A],
  [DOMAIN_C]: UPDATED_DOMAINS[DOMAIN_C],
};

describe('hyperlane warp routingMessageIdMultisigIsm CLI e2e tests (Sealevel)', function () {
  this.timeout(SVM_ROUTING_ISM_TIMEOUT);

  let signer: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;
  let mailboxAddress: string;
  let rpc: ReturnType<typeof createRpc>;

  const SYMBOL = 'RMIM';
  const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
  const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/svm-routing-message-id-multisig-ism-read.yaml`,
  );

  function buildDeployConfig(domains: Domains): WarpRouteDeployConfig {
    const owner = signer.getSignerAddress();
    return {
      [CHAIN_NAME]: {
        type: TokenType.native,
        name: 'Routing Message Id Multisig Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner,
        interchainSecurityModule: {
          type: IsmType.ROUTING_MESSAGE_ID_MULTISIG,
          owner,
          domains,
        },
      },
    };
  }

  async function applyDomains(domains: Domains) {
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, buildDeployConfig(domains));
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
  }

  async function readIsm() {
    const readConfig = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const ism = readConfig[CHAIN_NAME]?.interchainSecurityModule;
    assert(
      ism && typeof ism !== 'string',
      'Expected an expanded ISM config, not an address reference',
    );
    assert(
      ism.type === IsmType.ROUTING_MESSAGE_ID_MULTISIG,
      `Expected a ${IsmType.ROUTING_MESSAGE_ID_MULTISIG}, got ${ism.type}`,
    );
    assert(
      'address' in ism && typeof ism.address === 'string',
      'Expected the read ISM to carry its deployed address',
    );
    return { ism, address: ism.address };
  }

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

  // The suite's beforeEach wipes the registry's warp routes, so the whole
  // deploy -> apply lifecycle has to live in a single test.
  it('deploys, reads, updates in place, and redeploys on domain removal', async function () {
    writeYamlOrJson(
      WARP_DEPLOY_OUTPUT_PATH,
      buildDeployConfig(INITIAL_DOMAINS),
    );
    const deployOutput = await warpCommands
      .deployRaw({
        privateKey: SVM_KEY,
        skipConfirmationPrompts: true,
        warpRouteId,
        warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      })
      .nothrow();
    expect(deployOutput.exitCode).to.equal(0);

    const deployed = await readIsm();
    expect(deployed.ism.owner).to.equal(signer.getSignerAddress());
    expect(deployed.ism.domains).to.deep.equal(INITIAL_DOMAINS);

    // `warp check` compares altVM ISMs by address only, so exiting 0 proves the
    // router points at the ISM but not what its domains contain. The content
    // proof is the `readIsm()` deep-equal on the domains, so keep it next to
    // every check.
    const checkOutput = await warpCommands.checkRaw({ warpRouteId }).nothrow();
    expect(checkOutput.exitCode).to.equal(0);

    const noopOutput = await applyDomains(INITIAL_DOMAINS);
    expect(noopOutput.exitCode).to.equal(0);
    expect(noopOutput.stdout).to.include(NO_UPDATES_MESSAGE);
    const afterNoop = await readIsm();
    expect(afterNoop.address).to.equal(deployed.address);
    expect(afterNoop.ism.domains).to.deep.equal(INITIAL_DOMAINS);

    const updateOutput = await applyDomains(UPDATED_DOMAINS);
    expect(updateOutput.exitCode).to.equal(0);
    const updated = await readIsm();
    expect(updated.address).to.equal(deployed.address);
    expect(updated.ism.owner).to.equal(signer.getSignerAddress());
    expect(updated.ism.domains).to.deep.equal(UPDATED_DOMAINS);

    const updatedNoopOutput = await applyDomains(UPDATED_DOMAINS);
    expect(updatedNoopOutput.exitCode).to.equal(0);
    expect(updatedNoopOutput.stdout).to.include(NO_UPDATES_MESSAGE);

    const removeOutput = await applyDomains(REDUCED_DOMAINS);
    expect(removeOutput.exitCode).to.equal(0);
    const reduced = await readIsm();
    expect(reduced.address).to.not.equal(deployed.address);
    expect(reduced.ism.owner).to.equal(signer.getSignerAddress());
    expect(reduced.ism.domains).to.deep.equal(REDUCED_DOMAINS);

    const reducedCheckOutput = await warpCommands
      .checkRaw({ warpRouteId })
      .nothrow();
    expect(reducedCheckOutput.exitCode).to.equal(0);

    const reducedNoopOutput = await applyDomains(REDUCED_DOMAINS);
    expect(reducedNoopOutput.exitCode).to.equal(0);
    expect(reducedNoopOutput.stdout).to.include(NO_UPDATES_MESSAGE);
  });
});
