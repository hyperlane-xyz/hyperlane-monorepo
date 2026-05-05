import { expect } from 'chai';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import { SealevelSigner, createRpc } from '@hyperlane-xyz/sealevel-sdk';
import { airdropSol } from '@hyperlane-xyz/sealevel-sdk/testing';
import {
  TokenFeeType,
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
const SVM_KEY = HYP_KEY_BY_PROTOCOL.sealevel;
const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/svm-fee-apply-deploy.yaml`;

const SVM_WARP_FEE_APPLY_TIMEOUT = 600_000;

describe('hyperlane warp fee apply CLI e2e tests (Sealevel)', function () {
  this.timeout(SVM_WARP_FEE_APPLY_TIMEOUT);

  let signer: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;
  let mailboxAddress: string;

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/svm-fee-apply-read.yaml`,
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

  it('should add fee via apply when deployed without one', async function () {
    const ownerAddress = signer.getSignerAddress();
    const SYMBOL = 'ADDFEE';
    const warpRouteId = `${SYMBOL}/${CHAIN_NAME}`;

    const baseConfig = {
      type: TokenType.native,
      name: 'Add Fee Token',
      symbol: SYMBOL,
      decimals: 9,
      mailbox: mailboxAddress,
      owner: ownerAddress,
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
      [CHAIN_NAME]: baseConfig,
    } as WarpRouteDeployConfig);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const beforeApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    expect(beforeApply[CHAIN_NAME].tokenFee).to.be.undefined;

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
      [CHAIN_NAME]: {
        ...baseConfig,
        ...beforeApply[CHAIN_NAME],
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ownerAddress,
          bps: 75,
        },
      },
    });
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpRouteId,
      registryPath: REGISTRY_PATH,
    });
    await warpCommands.applyRaw({
      warpRouteId,
      hypKey: SVM_KEY,
      skipConfirmationPrompts: true,
    });

    const afterApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const fee = afterApply[CHAIN_NAME].tokenFee;
    assert(fee, 'Expected tokenFee after apply');
    expect(fee.type).to.equal(TokenFeeType.LinearFee);
    expect(fee.owner).to.equal(ownerAddress);
  });

  it('should update fee params via apply', async function () {
    const ownerAddress = signer.getSignerAddress();
    const SYMBOL = 'UPDFEE';
    const warpRouteId = `${SYMBOL}/${CHAIN_NAME}`;

    const baseConfig = {
      type: TokenType.native,
      name: 'Update Fee Token',
      symbol: SYMBOL,
      decimals: 9,
      mailbox: mailboxAddress,
      owner: ownerAddress,
      tokenFee: {
        type: TokenFeeType.LinearFee,
        owner: ownerAddress,
        bps: 50,
      },
    };

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
      [CHAIN_NAME]: baseConfig,
    } as WarpRouteDeployConfig);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const beforeApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    expect(beforeApply[CHAIN_NAME].tokenFee).to.not.be.undefined;

    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
      [CHAIN_NAME]: {
        ...baseConfig,
        ...beforeApply[CHAIN_NAME],
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ownerAddress,
          bps: 100,
        },
      },
    });
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpRouteId,
      registryPath: REGISTRY_PATH,
    });
    await warpCommands.applyRaw({
      warpRouteId,
      hypKey: SVM_KEY,
      skipConfirmationPrompts: true,
    });

    const afterApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const fee = afterApply[CHAIN_NAME].tokenFee;
    assert(fee, 'Expected tokenFee after apply');
    expect(fee.type).to.equal(TokenFeeType.LinearFee);
  });
});
