import { expect } from 'chai';
import { ethers } from 'hardhat';

import { error } from '@hyperlane-xyz/utils';

import { TestChains } from '../consts/chains';
import { MultiProvider } from '../providers/MultiProvider';
import { randomAddress, randomInt } from '../test/testUtils';

import {
  HyperlaneIsmFactory,
  moduleMatchesConfig,
} from './HyperlaneIsmFactory';
import { HyperlaneIsmFactoryDeployer } from './HyperlaneIsmFactoryDeployer';
import {
  AggregationIsmConfig,
  IsmConfig,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
} from './types';

function randomModuleType(): ModuleType {
  const choices = [
    ModuleType.AGGREGATION,
    ModuleType.MULTISIG,
    ModuleType.ROUTING,
  ];
  return choices[randomInt(choices.length)];
}

const randomMultisigIsmConfig = (m: number, n: number): MultisigIsmConfig => {
  const emptyArray = new Array<number>(n).fill(0);
  const validators = emptyArray.map(() => randomAddress());
  return {
    type: ModuleType.MULTISIG,
    validators,
    threshold: m,
  };
};

const randomIsmConfig = (depth = 0, maxDepth = 2): IsmConfig => {
  const moduleType =
    depth == maxDepth ? ModuleType.MULTISIG : randomModuleType();
  if (moduleType === ModuleType.MULTISIG) {
    const n = randomInt(5, 1);
    return randomMultisigIsmConfig(randomInt(n, 1), n);
  } else if (moduleType === ModuleType.ROUTING) {
    const config: RoutingIsmConfig = {
      type: ModuleType.ROUTING,
      owner: randomAddress(),
      domains: Object.fromEntries(
        TestChains.map((c) => [c, randomIsmConfig(depth + 1)]),
      ),
    };
    return config;
  } else if (moduleType === ModuleType.AGGREGATION) {
    const n = randomInt(5, 1);
    const modules = new Array<number>(n)
      .fill(0)
      .map(() => randomIsmConfig(depth + 1));
    const config: AggregationIsmConfig = {
      type: ModuleType.AGGREGATION,
      threshold: randomInt(n, 1),
      modules,
    };
    return config;
  } else {
    throw new Error(`Unsupported ISM type: ${moduleType}`);
  }
};

describe('HyperlaneIsmFactory', async () => {
  let factory: HyperlaneIsmFactory;
  const chain = 'test1';

  before(async () => {
    const [signer] = await ethers.getSigners();

    const multiProvider = MultiProvider.createTestMultiProvider({ signer });

    const deployer = new HyperlaneIsmFactoryDeployer(multiProvider);
    const contracts = await deployer.deploy([chain]);
    factory = new HyperlaneIsmFactory(contracts, multiProvider);
  });

  it('deploys a simple ism', async () => {
    const config = randomMultisigIsmConfig(3, 5);
    const ism = await factory.deploy(chain, config);
    const matches = await moduleMatchesConfig(
      chain,
      ism.address,
      config,
      factory.multiProvider,
      factory.getContracts(chain),
    );
    expect(matches).to.be.true;
  });

  for (let i = 0; i < 16; i++) {
    it('deploys a random ism config', async () => {
      const config = randomIsmConfig();
      let ismAddress: string;
      try {
        const ism = await factory.deploy(chain, config);
        ismAddress = ism.address;
      } catch (e) {
        error('Failed to deploy random ism config', e);
        error(JSON.stringify(config, null, 2));
        process.exit(1);
      }

      try {
        const matches = await moduleMatchesConfig(
          chain,
          ismAddress,
          config,
          factory.multiProvider,
          factory.getContracts(chain),
        );
        expect(matches).to.be.true;
      } catch (e) {
        error('Failed to match random ism config', e);
        error(JSON.stringify(config, null, 2));
        process.exit(1);
      }
    });
  }
});
