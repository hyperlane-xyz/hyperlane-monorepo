import {
  TestInterchainGasPaymaster__factory,
  TestIsm__factory,
  TestMailbox__factory,
  TestMerkleTreeHook__factory,
} from '@hyperlane-xyz/core';

import { TestChains } from '../consts/chains';
import { HyperlaneContracts } from '../contracts';
import { ChainMap, ChainName } from '../types';

import { HyperlaneCoreDeployer } from './HyperlaneCoreDeployer';
import { TestCoreApp } from './TestCoreApp';
import { CoreFactories } from './contracts';
import { CoreConfig } from './types';

export class TestCoreDeployer extends HyperlaneCoreDeployer {
  async deployContracts(
    chain: ChainName,
    _config: CoreConfig,
  ): Promise<HyperlaneContracts<CoreFactories>> {
    const domain = this.multiProvider.getDomainId(chain);
    const mailbox = await this.multiProvider.handleDeploy(
      chain,
      new TestMailbox__factory(),
      [domain],
    );

    const merkleTreeHook = await this.multiProvider.handleDeploy(
      chain,
      new TestMerkleTreeHook__factory(),
      [mailbox.address],
    );

    // deploy a test ISM instead of a real ISM
    const ism = await this.multiProvider.handleDeploy(
      chain,
      new TestIsm__factory(),
      [],
    );

    // deploy a test IGP instead of a real IGP
    const igp = await this.multiProvider.handleDeploy(
      chain,
      new TestInterchainGasPaymaster__factory(),
      [],
    );

    const owner = await this.multiProvider.getSignerAddress(chain);
    await mailbox.initialize(
      owner,
      ism.address,
      igp.address,
      merkleTreeHook.address,
    );

    // @ts-expect-error ts(2739)
    return { mailbox };
  }

  async deploy(): Promise<ChainMap<HyperlaneContracts<CoreFactories>>> {
    const testConfig: ChainMap<CoreConfig> = Object.fromEntries(
      TestChains.map((testChain) => [testChain, {} as any]),
    );
    return super.deploy(testConfig);
  }

  async deployApp(): Promise<TestCoreApp> {
    return new TestCoreApp(await this.deploy(), this.multiProvider);
  }
}
