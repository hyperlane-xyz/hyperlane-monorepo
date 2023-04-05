import { expect } from 'chai';
import { ethers } from 'hardhat';

import { error, types } from '@hyperlane-xyz/utils';

import { TestChains } from '../consts/chains';
import { MultiProvider } from '../providers/MultiProvider';

import { HyperlaneIsmFactory, moduleMatches } from './HyperlaneIsmFactory';
import { HyperlaneIsmFactoryDeployer } from './HyperlaneIsmFactoryDeployer';
import {
  AggregationIsmConfig,
  IsmConfig,
  ModuleType,
  MultisigIsmConfig,
  RoutingIsmConfig,
} from './types';

function randomInt(max: number, min = 0): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

function randomModuleType(): ModuleType {
  const max = ModuleType.MULTISIG + 1;
  let value = randomInt(max);
  // We do not return these module types.
  const excluded = [ModuleType.UNUSED, ModuleType.LEGACY_MULTISIG];
  while (excluded.includes(value)) {
    value = randomInt(max);
  }
  return value;
}

function randomAddress(): types.Address {
  return ethers.utils.hexlify(ethers.utils.randomBytes(20));
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
  switch (moduleType) {
    case ModuleType.MULTISIG: {
      const n = randomInt(5, 1);
      return randomMultisigIsmConfig(randomInt(n, 1), n);
    }
    case ModuleType.ROUTING: {
      const config: RoutingIsmConfig = {
        type: ModuleType.ROUTING,
        owner: randomAddress(),
        domains: Object.fromEntries(
          TestChains.map((c) => [c, randomIsmConfig(depth + 1)]),
        ),
      };
      return config;
    }
    case ModuleType.AGGREGATION: {
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
    }
    default: {
      throw new Error(`Unsupported ISM type: ${moduleType}`);
    }
  }
};

describe.only('HyperlaneIsmFactory', async () => {
  let factory: HyperlaneIsmFactory;
  const chain = 'test1';

  before(async () => {
    const [signer] = await ethers.getSigners();

    const multiProvider = MultiProvider.createTestMultiProvider({ signer });
    const configMap = Object.fromEntries(
      multiProvider.getKnownChainNames().map((chain) => [chain, true]),
    );

    const deployer = new HyperlaneIsmFactoryDeployer(multiProvider, configMap);
    const contracts = await deployer.deploy();
    factory = new HyperlaneIsmFactory(contracts, multiProvider);
  });

  it('deploys a simple ism', async () => {
    const config = randomMultisigIsmConfig(3, 5);
    const ism = await factory.deploy(chain, config);
    const matches = await moduleMatches(
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
        const matches = await moduleMatches(
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
