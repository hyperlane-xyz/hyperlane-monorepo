import debug from 'debug';

import {
  OptimismISM,
  OptimismISM__factory,
  OptimismMessageHook,
  OptimismMessageHook__factory,
  TestRecipient,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import { types } from '@hyperlane-xyz/utils';

import { HyperlaneContracts, HyperlaneContractsMap } from '../contracts';
import { HyperlaneDeployer } from '../deploy/HyperlaneDeployer';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { isHookConfig, isISMConfig } from './config';
import { HookFactories, hookFactories } from './contracts';
import { HookConfig } from './types';

export class HyperlaneHookDeployer extends HyperlaneDeployer<
  HookConfig,
  HookFactories
> {
  constructor(multiProvider: MultiProvider) {
    super(multiProvider, hookFactories, {
      logger: debug('hyperlane:HookDeployer'),
    });
  }

  async deploy(
    configMap: ChainMap<HookConfig>,
  ): Promise<HyperlaneContractsMap<HookFactories>> {
    let ismContracts: HyperlaneContracts<HookFactories> | undefined;
    let hookContracts: HyperlaneContracts<HookFactories> | undefined;

    // Process ISM configs first
    for (const [chain, config] of Object.entries(configMap)) {
      if (isISMConfig(config)) {
        ismContracts = await this.deployContracts(chain, config);
      }
    }

    // Ensure ISM contracts have been deployed
    if (!ismContracts) {
      throw new Error('ISM contracts not deployed');
    }

    // Then process hook configs
    for (const [chain, config] of Object.entries(configMap)) {
      if (isHookConfig(config)) {
        config.remoteIsm = ismContracts.optimismISM.address;
        this.logger(`Remote ISM address set as ${config.remoteIsm}`);
        hookContracts = await this.deployContracts(chain, config);
      }
    }

    // Ensure hook contracts have been deployed
    if (!hookContracts) {
      throw new Error('Hook contracts not deployed');
    }

    const hookAddress = hookContracts.optimismMessageHook.address;

    this.logger(`Setting hook address ${hookAddress} for OptimismISM`);
    await ismContracts.optimismISM.setOptimismHook(hookAddress);

    const deployedContractMap: HyperlaneContractsMap<HookFactories> = {
      optimismISM: ismContracts.optimismISM,
      testRecipient: ismContracts.testRecipient,
      optimismMessageHook: hookContracts.optimismMessageHook,
    };

    return deployedContractMap;
  }

  async deployContracts(
    chain: ChainName,
    hookConfig: HookConfig,
  ): Promise<HyperlaneContracts<HookFactories>> {
    let optimismISM, optimismMessageHook, testRecipient;
    this.logger(`Deploying ${hookConfig.nativeType} on ${chain}`);
    if (isISMConfig(hookConfig)) {
      optimismISM = await this.deployOptimismISM(
        chain,
        hookConfig.nativeBridge,
      );
      testRecipient = await this.deployTestRecipient(
        chain,
        optimismISM.address,
      );
      this.logger(
        `Deployed test recipient on ${chain} at ${this.padToBytes32(
          testRecipient.address,
        )}`,
      );

      return {
        optimismISM,
        testRecipient,
      };
    } else if (isHookConfig(hookConfig)) {
      optimismMessageHook = await this.deployOptimismMessageHook(
        chain,
        hookConfig.destinationDomain,
        hookConfig.nativeBridge,
        hookConfig.remoteIsm,
      );
      return {
        optimismMessageHook,
      };
    }
    return {};
  }

  async deployOptimismISM(
    chain: ChainName,
    nativeBridge: types.Address,
  ): Promise<OptimismISM> {
    const signer = this.multiProvider.getSigner(chain);

    const optimsimISM = await new OptimismISM__factory(signer).deploy(
      nativeBridge,
    );

    await this.multiProvider.handleTx(chain, optimsimISM.deployTransaction);

    this.logger(`Deployed OptimismISM on ${chain} at ${optimsimISM.address}`);
    return optimsimISM;
  }

  async deployTestRecipient(
    chain: ChainName,
    ism: types.Address,
  ): Promise<TestRecipient> {
    const signer = this.multiProvider.getSigner(chain);

    const testRecipient = await new TestRecipient__factory(signer).deploy();

    await this.multiProvider.handleTx(chain, testRecipient.deployTransaction);

    await testRecipient.setInterchainSecurityModule(ism);
    return testRecipient;
  }

  async deployOptimismMessageHook(
    chain: ChainName,
    destinationDomain: number,
    nativeBridge: types.Address,
    optimismISM: types.Address,
  ): Promise<OptimismMessageHook> {
    const signer = this.multiProvider.getSigner(chain);

    const optimismMessageHook = await new OptimismMessageHook__factory(
      signer,
    ).deploy(destinationDomain, nativeBridge, optimismISM);

    await this.multiProvider.handleTx(
      chain,
      optimismMessageHook.deployTransaction,
    );
    this.logger(
      `Deployed OptimismMessageHook on ${chain} at ${optimismMessageHook.address}`,
    );
    return optimismMessageHook;
  }

  // Function to pad a hexadecimal string to 32 bytes
  padToBytes32(hexString: string): string {
    // Check that it is indeed a hexidecimal string
    if (typeof hexString !== 'string' || !/^0x[0-9a-fA-F]*$/.test(hexString)) {
      throw new Error('The input should be a hexadecimal string');
    }

    // If the hexString is shorter than 64 characters (64 characters = 32 bytes),
    // add leading zeroes to make it 32 bytes long
    const unprefixedHexString = hexString.replace(/^0x/, ''); // remove '0x'
    if (unprefixedHexString.length < 64) {
      return `0x${unprefixedHexString.padStart(64, '0')}`;
    }

    // If it is already 32 bytes long or longer, just return it.
    return hexString;
  }
}
