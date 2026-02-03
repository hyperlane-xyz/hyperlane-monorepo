import { expect } from 'chai';
import { Wallet } from 'ethers';
import * as fs from 'fs';
import { $ } from 'zx';

import {
  type ERC20Test,
  type XERC20LockboxTest,
  type XERC20VSTest,
} from '@hyperlane-xyz/core';
import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type AnnotatedEV5Transaction,
  TokenType,
  type WarpCoreConfig,
  type WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { type Address } from '@hyperlane-xyz/utils';

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../consts.js';

import { deployOrUseExistingCore } from './core.js';
import {
  deployToken,
  deployXERC20LockboxToken,
  deployXERC20VSToken,
  localTestRunCmdPrefix,
} from './helpers.js';
import { hyperlaneWarpDeploy } from './warp.js';

$.verbose = true;

describe('warp xerc20 e2e tests', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let chain2Addresses: ChainAddresses;
  let chain3Addresses: ChainAddresses;
  let ownerAddress: Address;

  let tokenChain2: ERC20Test;
  let xERC20Lockbox2: XERC20LockboxTest;
  let xERC20VS2: XERC20VSTest;
  let xERC20VS3: XERC20VSTest;

  const XERC20_LOCKBOX_DEPLOY_PATH = `${TEMP_PATH}/warp-xerc20-lockbox-deploy.yaml`;
  const XERC20_VS_DEPLOY_PATH = `${TEMP_PATH}/warp-xerc20-vs-deploy.yaml`;
  const XERC20_VS_CORE_PATH = `${REGISTRY_PATH}/deployments/warp_routes/XERC20VS/anvil2-anvil3-config.yaml`;
  const TX_OUTPUT_PATH = `${TEMP_PATH}/xerc20-txs.yaml`;

  before(async function () {
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
    const vsWarpRouteAddress2 = xerc20VSCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_2,
    )?.addressOrDenom;
    const vsWarpRouteAddress3 = xerc20VSCoreConfig.tokens.find(
      (t) => t.chainName === CHAIN_NAME_3,
    )?.addressOrDenom;

    if (vsWarpRouteAddress2) {
      const tx = await xERC20VS2.addBridge({
        bridge: vsWarpRouteAddress2,
        bufferCap: '1000000000000000000000',
        rateLimitPerSecond: '1000000000000000000',
      });
      await tx.wait();
    }

    if (vsWarpRouteAddress3) {
      const tx = await xERC20VS3.addBridge({
        bridge: vsWarpRouteAddress3,
        bufferCap: '1000000000000000000000',
        rateLimitPerSecond: '1000000000000000000',
      });
      await tx.wait();
    }
  });

  afterEach(function () {
    if (fs.existsSync(TX_OUTPUT_PATH)) {
      fs.unlinkSync(TX_OUTPUT_PATH);
    }
  });

  describe('set-limits', function () {
    it('generates setLimits transaction for Velodrome XERC20', async function () {
      const testBridge = '0x0000000000000000000000000000000000000001';
      const bufferCap = '2000000000000000000000';
      const rateLimit = '2000000000000000000';

      await $`${localTestRunCmdPrefix()} hyperlane warp xerc20 set-limits \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_VS_DEPLOY_PATH} \
        --chain ${CHAIN_NAME_2} \
        --bridge ${testBridge} \
        --buffer-cap ${bufferCap} \
        --rate-limit ${rateLimit} \
        --out ${TX_OUTPUT_PATH} \
        --verbosity debug`;

      expect(fs.existsSync(TX_OUTPUT_PATH)).to.be.true;
      const transactions = readYamlOrJson(
        TX_OUTPUT_PATH,
      ) as AnnotatedEV5Transaction[];
      expect(transactions).to.be.an('array');
      expect(transactions.length).to.be.greaterThan(0);
      expect(transactions.length).to.equal(2);

      const tx = transactions[0];
      expect(tx).to.have.property('chainId');
      expect(tx).to.have.property('to');
      expect(tx).to.have.property('data');
      expect(tx.to!.toLowerCase()).to.equal(xERC20VS2.address.toLowerCase());
    });

    it('generates setLimits transaction for Standard XERC20 with mint/burn', async function () {
      const testBridge = '0x0000000000000000000000000000000000000002';
      const mintLimit = '1000000000000000000000';
      const burnLimit = '500000000000000000000';

      await $`${localTestRunCmdPrefix()} hyperlane warp xerc20 set-limits \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_LOCKBOX_DEPLOY_PATH} \
        --bridge ${testBridge} \
        --mint ${mintLimit} \
        --burn ${burnLimit} \
        --out ${TX_OUTPUT_PATH} \
        --verbosity debug`;

      expect(fs.existsSync(TX_OUTPUT_PATH)).to.be.true;
      const transactions = readYamlOrJson(
        TX_OUTPUT_PATH,
      ) as AnnotatedEV5Transaction[];
      expect(transactions).to.be.an('array');
      expect(transactions.length).to.equal(1);

      const tx = transactions[0];
      expect(tx).to.have.property('chainId');
      expect(tx).to.have.property('to');
      expect(tx).to.have.property('data');
    });
  });

  describe('add-bridge', function () {
    it('generates addBridge transaction for Velodrome XERC20', async function () {
      const newBridge = '0x0000000000000000000000000000000000000003';
      const bufferCap = '3000000000000000000000';
      const rateLimit = '3000000000000000000';

      await $`${localTestRunCmdPrefix()} hyperlane warp xerc20 add-bridge \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_VS_DEPLOY_PATH} \
        --chain ${CHAIN_NAME_2} \
        --bridge ${newBridge} \
        --buffer-cap ${bufferCap} \
        --rate-limit ${rateLimit} \
        --out ${TX_OUTPUT_PATH} \
        --verbosity debug`;

      expect(fs.existsSync(TX_OUTPUT_PATH)).to.be.true;
      const transactions = readYamlOrJson(
        TX_OUTPUT_PATH,
      ) as AnnotatedEV5Transaction[];
      expect(transactions).to.be.an('array');
      expect(transactions.length).to.equal(1);

      const tx = transactions[0];
      expect(tx).to.have.property('chainId');
      expect(tx).to.have.property('to');
      expect(tx).to.have.property('data');
      expect(tx.to!.toLowerCase()).to.equal(xERC20VS2.address.toLowerCase());
    });

    it('generates setLimits transaction for Standard XERC20 (add-bridge falls back to setLimits)', async function () {
      const newBridge = '0x0000000000000000000000000000000000000004';
      const mintLimit = '2000000000000000000000';
      const burnLimit = '1000000000000000000000';

      await $`${localTestRunCmdPrefix()} hyperlane warp xerc20 add-bridge \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_LOCKBOX_DEPLOY_PATH} \
        --bridge ${newBridge} \
        --mint ${mintLimit} \
        --burn ${burnLimit} \
        --out ${TX_OUTPUT_PATH} \
        --verbosity debug`;

      expect(fs.existsSync(TX_OUTPUT_PATH)).to.be.true;
      const transactions = readYamlOrJson(
        TX_OUTPUT_PATH,
      ) as AnnotatedEV5Transaction[];
      expect(transactions).to.be.an('array');
      expect(transactions.length).to.equal(1);
    });
  });

  describe('remove-bridge', function () {
    it('generates removeBridge transaction for Velodrome XERC20', async function () {
      const bridgeToRemove = '0x0000000000000000000000000000000000000005';
      const addTx = await xERC20VS2.addBridge({
        bridge: bridgeToRemove,
        bufferCap: '1000000000000000000',
        rateLimitPerSecond: '1000000000000000',
      });
      await addTx.wait();

      await $`${localTestRunCmdPrefix()} hyperlane warp xerc20 remove-bridge \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_VS_DEPLOY_PATH} \
        --chain ${CHAIN_NAME_2} \
        --bridge ${bridgeToRemove} \
        --out ${TX_OUTPUT_PATH} \
        --verbosity debug`;

      expect(fs.existsSync(TX_OUTPUT_PATH)).to.be.true;
      const transactions = readYamlOrJson(
        TX_OUTPUT_PATH,
      ) as AnnotatedEV5Transaction[];
      expect(transactions).to.be.an('array');
      expect(transactions.length).to.equal(1);

      const tx = transactions[0];
      expect(tx).to.have.property('chainId');
      expect(tx).to.have.property('to');
      expect(tx).to.have.property('data');
      expect(tx.to!.toLowerCase()).to.equal(xERC20VS2.address.toLowerCase());
    });

    it('fails for Standard XERC20 (remove-bridge not supported)', async function () {
      const bridgeToRemove = '0x0000000000000000000000000000000000000006';

      let errorThrown = false;
      try {
        await $`${localTestRunCmdPrefix()} hyperlane warp xerc20 remove-bridge \
          --registry ${REGISTRY_PATH} \
          --config ${XERC20_LOCKBOX_DEPLOY_PATH} \
          --bridge ${bridgeToRemove} \
          --out ${TX_OUTPUT_PATH} \
          --verbosity debug`;
      } catch (error) {
        errorThrown = true;
      }

      expect(errorThrown || !fs.existsSync(TX_OUTPUT_PATH)).to.be.true;
    });
  });

  describe('view-limits', function () {
    it('displays current limits for Velodrome XERC20', async function () {
      const result =
        await $`${localTestRunCmdPrefix()} hyperlane warp xerc20 view-limits \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_VS_DEPLOY_PATH} \
        --chain ${CHAIN_NAME_2} \
        --verbosity debug`;

      const output = result.stdout;
      expect(output).to.include('velodrome');
    });

    it('displays current limits for Standard XERC20', async function () {
      const result =
        await $`${localTestRunCmdPrefix()} hyperlane warp xerc20 view-limits \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_LOCKBOX_DEPLOY_PATH} \
        --verbosity debug`;

      const output = result.stdout;
      expect(output).to.include(CHAIN_NAME_2);
    });
  });

  describe('multi-chain operations', function () {
    it('updates all chains when --chain is not specified', async function () {
      const testBridge = '0x0000000000000000000000000000000000000007';
      const bufferCap = '5000000000000000000000';
      const rateLimit = '5000000000000000000';

      await $`${localTestRunCmdPrefix()} hyperlane warp xerc20 set-limits \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_VS_DEPLOY_PATH} \
        --bridge ${testBridge} \
        --buffer-cap ${bufferCap} \
        --rate-limit ${rateLimit} \
        --out ${TX_OUTPUT_PATH} \
        --verbosity debug`;

      expect(fs.existsSync(TX_OUTPUT_PATH)).to.be.true;
      const transactions = readYamlOrJson(
        TX_OUTPUT_PATH,
      ) as AnnotatedEV5Transaction[];
      expect(transactions).to.be.an('array');
      expect(transactions.length).to.equal(4);

      const chainIds = new Set(transactions.map((tx) => tx.chainId));
      expect(chainIds.size).to.equal(2);
    });

    it('--chain filter works correctly for single chain', async function () {
      const testBridge = '0x0000000000000000000000000000000000000008';
      const bufferCap = '6000000000000000000000';
      const rateLimit = '6000000000000000000';

      await $`${localTestRunCmdPrefix()} hyperlane warp xerc20 set-limits \
        --registry ${REGISTRY_PATH} \
        --config ${XERC20_VS_DEPLOY_PATH} \
        --chain ${CHAIN_NAME_3} \
        --bridge ${testBridge} \
        --buffer-cap ${bufferCap} \
        --rate-limit ${rateLimit} \
        --out ${TX_OUTPUT_PATH} \
        --verbosity debug`;

      expect(fs.existsSync(TX_OUTPUT_PATH)).to.be.true;
      const transactions = readYamlOrJson(
        TX_OUTPUT_PATH,
      ) as AnnotatedEV5Transaction[];
      expect(transactions).to.be.an('array');
      expect(transactions.length).to.equal(2);

      const chainIds = new Set(transactions.map((tx) => tx.chainId));
      expect(chainIds.size).to.equal(1);
    });
  });

  describe('error handling', function () {
    it('fails when mixing Standard and Velodrome limit options', async function () {
      const testBridge = '0x0000000000000000000000000000000000000009';

      let errorThrown = false;
      try {
        await $`${localTestRunCmdPrefix()} hyperlane warp xerc20 set-limits \
          --registry ${REGISTRY_PATH} \
          --config ${XERC20_VS_DEPLOY_PATH} \
          --bridge ${testBridge} \
          --mint 1000 \
          --buffer-cap 2000 \
          --out ${TX_OUTPUT_PATH} \
          --verbosity debug`;
      } catch (error) {
        errorThrown = true;
      }

      expect(errorThrown).to.be.true;
    });

    it('fails when required limit options are missing', async function () {
      const testBridge = '0x000000000000000000000000000000000000000a';

      let errorThrown = false;
      try {
        await $`${localTestRunCmdPrefix()} hyperlane warp xerc20 set-limits \
          --registry ${REGISTRY_PATH} \
          --config ${XERC20_LOCKBOX_DEPLOY_PATH} \
          --bridge ${testBridge} \
          --mint 1000 \
          --out ${TX_OUTPUT_PATH} \
          --verbosity debug`;
      } catch (error) {
        errorThrown = true;
      }

      expect(errorThrown).to.be.true;
    });
  });
});
