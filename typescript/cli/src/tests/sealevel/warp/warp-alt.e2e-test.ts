import { expect } from 'chai';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
import { SealevelSigner, createRpc } from '@hyperlane-xyz/sealevel-sdk';
import { airdropSol } from '@hyperlane-xyz/sealevel-sdk/testing';
import {
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { HyperlaneE2ECoreTestCommands } from '../../commands/core.js';
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
const SVM_KEY = HYP_KEY_BY_PROTOCOL.sealevel;
const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/svm-alt-warp-deploy.yaml`;

const SVM_WARP_ALT_TIMEOUT = 600_000;

describe('hyperlane warp alt CLI e2e tests (Sealevel)', function () {
  this.timeout(SVM_WARP_ALT_TIMEOUT);

  let signer: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;
  let mailboxAddress: string;

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/svm-alt-warp-read.yaml`,
  );

  before(async function () {
    const rpcUrl = TEST_CHAIN_METADATA_BY_PROTOCOL.sealevel.CHAIN_NAME_1.rpcUrl;
    const rpc = createRpc(rpcUrl);
    signer = await SealevelSigner.connectWithSigner([rpcUrl], SVM_KEY);

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

  it('creates ALTs, populates registry, and check exits clean', async function () {
    const ownerAddress = signer.getSignerAddress();
    const SYMBOL = 'ALTKN';

    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
    const config: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.native,
        name: 'ALT Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, config);
    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    // Before create — no alt entries in the registry.
    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const preCreate: WarpCoreConfig = readYamlOrJson(warpCorePath);
    expect(preCreate.options?.svmAltAddresses?.[CHAIN_NAME]).to.equal(
      undefined,
    );

    // Create both ALTs and persist them to the registry.
    await warpCommands.altCreate(SVM_KEY, warpRouteId);

    const postCreate: WarpCoreConfig = readYamlOrJson(warpCorePath);
    const altEntry = postCreate.options?.svmAltAddresses?.[CHAIN_NAME];
    expect(altEntry, 'svmAltAddresses entry written').to.be.an('object');
    expect(altEntry!.core, 'core ALT is a non-empty string')
      .to.be.a('string')
      .and.to.have.length.greaterThan(0);
    expect(altEntry!.warpSpecific, 'warpSpecific is non-empty array')
      .to.be.an('array')
      .with.lengthOf(1);
    expect(altEntry!.warpSpecific[0])
      .to.be.a('string')
      .and.to.have.length.greaterThan(0);

    // `warp alt read` exits 0 and prints the on-chain ALT contents.
    await warpCommands.altRead(warpRouteId);

    // `warp alt check` exits 0 immediately after create — no diffs.
    await warpCommands.altCheck(warpRouteId);
  });
});
