import { expect } from 'chai';

import {
  type ChainAddresses,
  createWarpRouteConfigId,
} from '@hyperlane-xyz/registry';
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
    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);

    const baseConfig = {
      type: TokenType.native,
      name: 'Add Fee Token',
      symbol: SYMBOL,
      decimals: 9,
      mailbox: mailboxAddress,
      owner: ownerAddress,
    };

    const deployConfig: WarpRouteDeployConfig = { [CHAIN_NAME]: baseConfig };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, deployConfig);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const beforeApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    expect(beforeApply[CHAIN_NAME].tokenFee).to.be.undefined;

    const applyConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        ...baseConfig,
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ownerAddress,
          bps: 75,
        },
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, applyConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpRouteId,
      registryPath: REGISTRY_PATH,
    });
    await warpCommands.applyRaw({
      warpRouteId,
      privateKey: SVM_KEY,
      skipConfirmationPrompts: true,
    });

    const afterApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const fee = afterApply[CHAIN_NAME].tokenFee;
    assert(fee, 'Expected tokenFee after apply');
    assert(
      fee.type === TokenFeeType.LinearFee,
      `Expected LinearFee, got ${fee.type}`,
    );
    expect(fee.owner).to.equal(ownerAddress);
    expect(fee.bps).to.equal(75);
  });

  it('should update fee params via apply', async function () {
    const ownerAddress = signer.getSignerAddress();
    const SYMBOL = 'UPDFEE';
    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);

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

    const deployConfig: WarpRouteDeployConfig = { [CHAIN_NAME]: baseConfig };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, deployConfig);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const beforeApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    expect(beforeApply[CHAIN_NAME].tokenFee).to.not.be.undefined;

    const applyConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        ...baseConfig,
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ownerAddress,
          bps: 100,
        },
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, applyConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpRouteId,
      registryPath: REGISTRY_PATH,
    });
    await warpCommands.applyRaw({
      warpRouteId,
      privateKey: SVM_KEY,
      skipConfirmationPrompts: true,
    });

    const afterApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const fee = afterApply[CHAIN_NAME].tokenFee;
    assert(fee, 'Expected tokenFee after apply');
    assert(
      fee.type === TokenFeeType.LinearFee,
      `Expected LinearFee, got ${fee.type}`,
    );
    expect(fee.bps).to.equal(100);
  });

  it('should remove fee via apply', async function () {
    const ownerAddress = signer.getSignerAddress();
    const SYMBOL = 'RMFEE';
    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);

    const baseConfig = {
      type: TokenType.native,
      name: 'Remove Fee Token',
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

    const deployConfig: WarpRouteDeployConfig = { [CHAIN_NAME]: baseConfig };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, deployConfig);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const beforeApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    expect(beforeApply[CHAIN_NAME].tokenFee).to.not.be.undefined;

    const { tokenFee: _, ...withoutFee } = baseConfig;
    const applyConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME]: withoutFee,
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, applyConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpRouteId,
      registryPath: REGISTRY_PATH,
    });
    await warpCommands.applyRaw({
      warpRouteId,
      privateKey: SVM_KEY,
      skipConfirmationPrompts: true,
    });

    const afterApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    expect(afterApply[CHAIN_NAME].tokenFee).to.be.undefined;
  });

  it('should add a quote signer to OffchainQuotedLinearFee via apply', async function () {
    const ownerAddress = signer.getSignerAddress();
    const SYMBOL = 'OQSIGN';
    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
    const SIGNER_A = '0x000000000000000000000000000000000000000A';
    const SIGNER_B = '0x000000000000000000000000000000000000000B';

    const baseConfig = {
      type: TokenType.native,
      name: 'OQ Signers Token',
      symbol: SYMBOL,
      decimals: 9,
      mailbox: mailboxAddress,
      owner: ownerAddress,
      tokenFee: {
        type: TokenFeeType.OffchainQuotedLinearFee,
        owner: ownerAddress,
        bps: 50,
        quoteSigners: [SIGNER_A],
      },
    };

    const deployConfig: WarpRouteDeployConfig = { [CHAIN_NAME]: baseConfig };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, deployConfig);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const beforeApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const beforeFee = beforeApply[CHAIN_NAME].tokenFee;
    assert(beforeFee, 'Expected tokenFee after deploy');
    assert(
      beforeFee.type === TokenFeeType.OffchainQuotedLinearFee,
      `Expected OffchainQuotedLinearFee, got ${beforeFee.type}`,
    );
    expect(beforeFee.quoteSigners?.map((s) => s.toLowerCase())).to.deep.equal([
      SIGNER_A.toLowerCase(),
    ]);

    const applyConfig: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        ...baseConfig,
        tokenFee: {
          type: TokenFeeType.OffchainQuotedLinearFee,
          owner: ownerAddress,
          bps: 50,
          quoteSigners: [SIGNER_A, SIGNER_B],
        },
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, applyConfig);
    syncWarpDeployConfigToRegistry({
      warpDeployPath: WARP_DEPLOY_OUTPUT_PATH,
      warpRouteId,
      registryPath: REGISTRY_PATH,
    });
    await warpCommands.applyRaw({
      warpRouteId,
      privateKey: SVM_KEY,
      skipConfirmationPrompts: true,
    });

    const afterApply = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const afterFee = afterApply[CHAIN_NAME].tokenFee;
    assert(afterFee, 'Expected tokenFee after apply');
    assert(
      afterFee.type === TokenFeeType.OffchainQuotedLinearFee,
      `Expected OffchainQuotedLinearFee, got ${afterFee.type}`,
    );
    expect(afterFee.bps).to.equal(50);
    expect(
      new Set(afterFee.quoteSigners?.map((s) => s.toLowerCase())),
    ).to.deep.equal(new Set([SIGNER_A.toLowerCase(), SIGNER_B.toLowerCase()]));
  });
});
