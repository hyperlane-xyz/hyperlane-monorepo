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
import { HyperlaneE2EWarpTestCommands } from '../../commands/warp.js';
import {
  BURN_ADDRESS_BY_PROTOCOL,
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
const WARP_DEPLOY_OUTPUT_PATH = `${TEMP_PATH}/svm-fee-warp-deploy.yaml`;

const SVM_WARP_FEE_TIMEOUT = 600_000;

describe('hyperlane warp fee CLI e2e tests (Sealevel)', function () {
  this.timeout(SVM_WARP_FEE_TIMEOUT);

  let signer: Awaited<ReturnType<typeof SealevelSigner.connectWithSigner>>;
  let mailboxAddress: string;

  const warpCommands = new HyperlaneE2EWarpTestCommands(
    ProtocolType.Sealevel,
    REGISTRY_PATH,
    `${TEMP_PATH}/svm-fee-warp-read.yaml`,
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

  it('should deploy a native warp route with LinearFee (bps) on SVM', async function () {
    const ownerAddress = signer.getSignerAddress();
    const BPS = 50;
    const SYMBOL = 'FTKN';

    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
    const config: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.native,
        name: 'Fee Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ownerAddress,
          bps: BPS,
        },
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, config);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    // Read config back via CLI warp read and verify fee was deployed
    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const readConfig = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const chainConfig = readConfig[CHAIN_NAME];

    const fee = chainConfig.tokenFee;
    assert(fee, 'Expected tokenFee after deploy');
    assert(
      fee.type === TokenFeeType.LinearFee,
      `Expected LinearFee, got ${fee.type}`,
    );
    expect(fee.owner).to.equal(ownerAddress);
    expect(fee.bps).to.equal(BPS);
  });

  it('should deploy a native warp route with RoutingFee (multiple domains) on SVM', async function () {
    const ownerAddress = signer.getSignerAddress();
    const SYMBOL = 'RTKN';

    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
    const config: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.native,
        name: 'Routing Fee Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
        remoteRouters: {
          anvil1: {
            address:
              '0x1111111111111111111111111111111111111111111111111111111111111111',
          },
          anvil2: {
            address:
              '0x2222222222222222222222222222222222222222222222222222222222222222',
          },
        },
        tokenFee: {
          type: TokenFeeType.RoutingFee,
          owner: ownerAddress,
          feeContracts: {
            anvil1: {
              type: TokenFeeType.LinearFee,
              bps: 50,
            },
            anvil2: {
              type: TokenFeeType.LinearFee,
              bps: 100,
            },
          },
        },
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, config);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const readConfig = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const chainConfig = readConfig[CHAIN_NAME];

    const fee = chainConfig.tokenFee;
    assert(fee, 'Expected tokenFee to be defined');
    expect(fee.type).to.equal(TokenFeeType.RoutingFee);
    expect(fee.owner).to.equal(ownerAddress);

    assert(
      fee.type === TokenFeeType.RoutingFee,
      'Expected RoutingFee type for narrowing',
    );

    const anvil1 = fee.feeContracts.anvil1;
    assert(anvil1, 'Expected anvil1 fee contract');
    assert(
      anvil1.type === TokenFeeType.LinearFee,
      `Expected LinearFee for anvil1, got ${anvil1.type}`,
    );
    expect(anvil1.bps).to.equal(50);

    const anvil2 = fee.feeContracts.anvil2;
    assert(anvil2, 'Expected anvil2 fee contract');
    assert(
      anvil2.type === TokenFeeType.LinearFee,
      `Expected LinearFee for anvil2, got ${anvil2.type}`,
    );
    expect(anvil2.bps).to.equal(100);
  });

  it('should set beneficiary explicitly when provided in tokenFee config', async function () {
    const ownerAddress = signer.getSignerAddress();
    const beneficiaryAddress = BURN_ADDRESS_BY_PROTOCOL[ProtocolType.Sealevel];
    const SYMBOL = 'BENEF';

    const warpRouteId = createWarpRouteConfigId(SYMBOL, CHAIN_NAME);
    const config: WarpRouteDeployConfig = {
      [CHAIN_NAME]: {
        type: TokenType.native,
        name: 'Beneficiary Token',
        symbol: SYMBOL,
        decimals: 9,
        mailbox: mailboxAddress,
        owner: ownerAddress,
        tokenFee: {
          type: TokenFeeType.LinearFee,
          owner: ownerAddress,
          beneficiary: beneficiaryAddress,
          bps: 50,
        },
      },
    };
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, config);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const readConfig = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const fee = readConfig[CHAIN_NAME].tokenFee;
    assert(fee, 'Expected tokenFee after deploy');
    assert(
      fee.type === TokenFeeType.LinearFee,
      `Expected LinearFee, got ${fee.type}`,
    );
    expect(fee.beneficiary).to.equal(beneficiaryAddress);
    expect(fee.beneficiary).to.not.equal(ownerAddress);
  });
});
