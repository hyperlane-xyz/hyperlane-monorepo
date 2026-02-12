import { JsonRpcProvider } from '@ethersproject/providers';
import * as chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { Wallet, constants } from 'ethers';
import { $, type ProcessPromise } from 'zx';

import { TransferRouter__factory } from '@hyperlane-xyz/core';
import { type ChainMetadata, TokenFeeType } from '@hyperlane-xyz/sdk';

import type {
  TransferRouterDeployConfig,
  TransferRouterOutput,
} from '../../../transfer-router/types.js';
import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployToken, localTestRunCmdPrefix } from '../commands/helpers.js';
import {
  ANVIL_KEY,
  CHAIN_2_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../consts.js';

chai.use(chaiAsPromised);
const expect = chai.expect;
chai.should();

const TRANSFER_ROUTER_CONFIG_PATH = `${TEMP_PATH}/transfer-router-deployment.yaml`;
const TRANSFER_ROUTER_OUTPUT_PATH = `${TEMP_PATH}/transfer-router-output.yaml`;

function hyperlaneTransferRouterDeploy(
  configPath: string,
  outPath: string,
): ProcessPromise {
  return $`${localTestRunCmdPrefix()} hyperlane transfer-router deploy \
    --registry ${REGISTRY_PATH} \
    --config ${configPath} \
    --out ${outPath} \
    --key ${ANVIL_KEY} \
    --yes`;
}

describe('hyperlane transfer-router deploy', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let ownerAddress: string;
  let providerChain2: JsonRpcProvider;
  let providerChain3: JsonRpcProvider;

  before(async function () {
    const chain2Metadata: ChainMetadata = readYamlOrJson(CHAIN_2_METADATA_PATH);
    providerChain2 = new JsonRpcProvider(chain2Metadata.rpcUrls[0].http);
    const walletChain2 = new Wallet(ANVIL_KEY).connect(providerChain2);
    ownerAddress = walletChain2.address;

    const chain3MetadataPath = `${REGISTRY_PATH}/chains/${CHAIN_NAME_3}/metadata.yaml`;
    const chain3Metadata: ChainMetadata = readYamlOrJson(chain3MetadataPath);
    providerChain3 = new JsonRpcProvider(chain3Metadata.rpcUrls[0].http);
  });

  it('should deploy TransferRouter with LinearFee', async function () {
    const token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);

    const deployConfig: TransferRouterDeployConfig = {
      [CHAIN_NAME_2]: {
        token: token.address,
        owner: ownerAddress,
        fee: {
          type: TokenFeeType.LinearFee,
          owner: ownerAddress,
          bps: 100n,
        },
      },
    };

    writeYamlOrJson(TRANSFER_ROUTER_CONFIG_PATH, deployConfig);

    const result = await hyperlaneTransferRouterDeploy(
      TRANSFER_ROUTER_CONFIG_PATH,
      TRANSFER_ROUTER_OUTPUT_PATH,
    );
    expect(result.exitCode).to.equal(0);

    const output: TransferRouterOutput = readYamlOrJson(
      TRANSFER_ROUTER_OUTPUT_PATH,
    );
    expect(output[CHAIN_NAME_2]).to.exist;
    expect(output[CHAIN_NAME_2].transferRouter).to.be.a('string');
    expect(output[CHAIN_NAME_2].token).to.equal(token.address);
    expect(output[CHAIN_NAME_2].owner).to.equal(ownerAddress);

    const router = TransferRouter__factory.connect(
      output[CHAIN_NAME_2].transferRouter,
      providerChain2,
    );
    expect(await router.token()).to.equal(token.address);
    expect(await router.owner()).to.equal(ownerAddress);
    expect(await router.feeContract()).to.not.equal(constants.AddressZero);
    expect(output[CHAIN_NAME_2].feeContract).to.not.equal(
      constants.AddressZero,
    );
  });

  it('should deploy TransferRouter without fee (feeContract = address(0))', async function () {
    const token = await deployToken(ANVIL_KEY, CHAIN_NAME_2);

    const deployConfig: TransferRouterDeployConfig = {
      [CHAIN_NAME_2]: {
        token: token.address,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(TRANSFER_ROUTER_CONFIG_PATH, deployConfig);

    const result = await hyperlaneTransferRouterDeploy(
      TRANSFER_ROUTER_CONFIG_PATH,
      TRANSFER_ROUTER_OUTPUT_PATH,
    );
    expect(result.exitCode).to.equal(0);

    const output: TransferRouterOutput = readYamlOrJson(
      TRANSFER_ROUTER_OUTPUT_PATH,
    );
    expect(output[CHAIN_NAME_2]).to.exist;

    const router = TransferRouter__factory.connect(
      output[CHAIN_NAME_2].transferRouter,
      providerChain2,
    );
    expect(await router.token()).to.equal(token.address);
    expect(await router.owner()).to.equal(ownerAddress);
    expect(await router.feeContract()).to.equal(constants.AddressZero);
    expect(output[CHAIN_NAME_2].feeContract).to.equal(constants.AddressZero);
  });

  it('should deploy TransferRouter on multiple chains', async function () {
    const tokenChain2 = await deployToken(ANVIL_KEY, CHAIN_NAME_2);
    const tokenChain3 = await deployToken(ANVIL_KEY, CHAIN_NAME_3);

    const deployConfig: TransferRouterDeployConfig = {
      [CHAIN_NAME_2]: {
        token: tokenChain2.address,
        owner: ownerAddress,
      },
      [CHAIN_NAME_3]: {
        token: tokenChain3.address,
        owner: ownerAddress,
        fee: {
          type: TokenFeeType.LinearFee,
          owner: ownerAddress,
          bps: 50n,
        },
      },
    };

    writeYamlOrJson(TRANSFER_ROUTER_CONFIG_PATH, deployConfig);

    const result = await hyperlaneTransferRouterDeploy(
      TRANSFER_ROUTER_CONFIG_PATH,
      TRANSFER_ROUTER_OUTPUT_PATH,
    );
    expect(result.exitCode).to.equal(0);

    const output: TransferRouterOutput = readYamlOrJson(
      TRANSFER_ROUTER_OUTPUT_PATH,
    );

    expect(output[CHAIN_NAME_2]).to.exist;
    const routerChain2 = TransferRouter__factory.connect(
      output[CHAIN_NAME_2].transferRouter,
      providerChain2,
    );
    expect(await routerChain2.token()).to.equal(tokenChain2.address);
    expect(await routerChain2.owner()).to.equal(ownerAddress);
    expect(await routerChain2.feeContract()).to.equal(constants.AddressZero);

    expect(output[CHAIN_NAME_3]).to.exist;
    const routerChain3 = TransferRouter__factory.connect(
      output[CHAIN_NAME_3].transferRouter,
      providerChain3,
    );
    expect(await routerChain3.token()).to.equal(tokenChain3.address);
    expect(await routerChain3.owner()).to.equal(ownerAddress);
    expect(await routerChain3.feeContract()).to.not.equal(
      constants.AddressZero,
    );
  });

  it('should reject invalid token address', async function () {
    const invalidToken = '0x0000000000000000000000000000000000000001';

    const deployConfig: TransferRouterDeployConfig = {
      [CHAIN_NAME_2]: {
        token: invalidToken,
        owner: ownerAddress,
      },
    };

    writeYamlOrJson(TRANSFER_ROUTER_CONFIG_PATH, deployConfig);

    await hyperlaneTransferRouterDeploy(
      TRANSFER_ROUTER_CONFIG_PATH,
      TRANSFER_ROUTER_OUTPUT_PATH,
    ).should.be.rejected;
  });

  it('should reject empty config', async function () {
    writeYamlOrJson(TRANSFER_ROUTER_CONFIG_PATH, {});

    await hyperlaneTransferRouterDeploy(
      TRANSFER_ROUTER_CONFIG_PATH,
      TRANSFER_ROUTER_OUTPUT_PATH,
    ).should.be.rejected;
  });
});
