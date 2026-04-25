import { expect } from 'chai';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import { SealevelSigner, createRpc } from '@hyperlane-xyz/sealevel-sdk';
import { airdropSol } from '@hyperlane-xyz/sealevel-sdk/testing';
import {
  TokenFeeType,
  TokenType,
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

    const warpRouteId = `${SYMBOL}/${CHAIN_NAME}`;
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, {
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
    } as WarpRouteDeployConfig);

    await warpCommands.deploy(SVM_KEY, warpRouteId, WARP_DEPLOY_OUTPUT_PATH);

    // Read config back via CLI warp read and verify fee was deployed
    const warpCorePath = getWarpCoreConfigPath(SYMBOL, [CHAIN_NAME]);
    const readConfig = await warpCommands.readConfig(CHAIN_NAME, warpCorePath);
    const chainConfig = readConfig[CHAIN_NAME];

    expect(chainConfig.tokenFee).to.not.be.undefined;
    expect(chainConfig.tokenFee!.type).to.equal(TokenFeeType.LinearFee);
    expect(chainConfig.tokenFee!.owner).to.equal(ownerAddress);
  });
});
