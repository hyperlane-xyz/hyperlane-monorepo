import { expect } from 'chai';

import {
  AggregationIsmConfig,
  ChainTechnicalStack,
  CoreConfig,
  DomainRoutingIsmConfig,
  HookType,
  IsmType,
} from '@hyperlane-xyz/sdk';
import { assert, objFilter } from '@hyperlane-xyz/utils';

import { environments } from '../config/environments/index.js';
import { isEthereumProtocolChain } from '../src/utils/utils.js';

describe('Environment', () => {
  for (const env of Object.values(environments)) {
    it(`Has owners configured for ${env.environment}`, () => {
      for (const chain of env.supportedChainNames) {
        expect(
          env.owners[chain],
          `Missing owner for chain ${chain} in environment ${env.environment}`,
        ).to.not.be.undefined;
      }
    });
  }

  for (const env of [environments.testnet4, environments.mainnet3]) {
    describe(`Core config for ${env.environment}`, () => {
      it('should generate core config for all supported chains', async () => {
        const { core, supportedChainNames, getMultiProvider } = env;
        const multiProvider = await getMultiProvider();

        const ethereumCoreConfigs = objFilter(
          core,
          (chain, _): _ is CoreConfig => isEthereumProtocolChain(chain),
        );

        for (const chain of Object.keys(ethereumCoreConfigs)) {
          // Skip eden and tron as they have limited connectivity
          if (chain === 'eden' || chain === 'tron') {
            continue;
          }

          const defaultIsm = core[chain].defaultIsm;
          const chainMetadata = multiProvider.getChainMetadata(chain);

          // Verify the default ISM is not a string
          assert(
            typeof defaultIsm !== 'string',
            'defaultIsm should not be a string',
          );

          const isZksyncChain =
            chainMetadata.technicalStack === ChainTechnicalStack.ZkSync;

          // For zkSync chains, use defaultIsm directly as the routing ISM
          // For non-zkSync chains, find the routing ISM within the aggregation modules
          let routingIsm: DomainRoutingIsmConfig;
          if (isZksyncChain) {
            assert(
              defaultIsm.type === IsmType.ROUTING,
              `defaultIsm for ${chain} should be a routing ISM`,
            );
            routingIsm = defaultIsm as DomainRoutingIsmConfig;
          } else {
            assert(
              defaultIsm.type === IsmType.AGGREGATION,
              `defaultIsm for ${chain} should be an aggregation ISM`,
            );
            // Find the routing ISM within the modules
            routingIsm = (defaultIsm as AggregationIsmConfig).modules.find(
              (module) => {
                assert(
                  typeof module !== 'string',
                  'aggregationmodule should not be a string',
                );

                return module.type === IsmType.ROUTING;
              },
            ) as DomainRoutingIsmConfig;
            expect(routingIsm).to.not.be.undefined;
          }

          // Get the domains from the routing ISM
          const routingIsmDomains = routingIsm.domains;

          // Check that domains includes all chains except the local one
          // forma and eden are excluded as they have special connectivity
          const expectedChains = supportedChainNames
            .filter((c) => c !== chain)
            .filter((c) => c !== 'forma')
            .filter((c) => c !== 'eden');

          // Verify no unexpected chains in domains
          expect(Object.keys(routingIsmDomains)).to.have.lengthOf(
            expectedChains.length,
          );
          expect(Object.keys(routingIsmDomains)).to.not.include(chain);
          expect(Object.keys(routingIsmDomains)).to.not.include('forma');
          expect(Object.keys(routingIsmDomains)).to.not.include('eden');

          // Verify each expected chain has an entry in the domains
          for (const expectedChain of expectedChains) {
            expect(routingIsmDomains[expectedChain]).to.not.be.undefined;
          }
        }
      });
    });
  }

  it('recovers only the reviewed mainnet3 legacy hook trees', () => {
    const recoveredChains = Object.entries(environments.mainnet3.core)
      .filter(([, config]) => {
        const defaultHook = config.defaultHook;
        return (
          typeof defaultHook !== 'string' &&
          defaultHook.type === HookType.FALLBACK_ROUTING &&
          defaultHook.address !== undefined
        );
      })
      .map(([chain]) => chain)
      .sort();

    expect(recoveredChains).to.deep.equal([
      'coti',
      'electroneum',
      'krown',
      'metis',
      'pulsechain',
      'sei',
      'sonic',
      'taiko',
      'viction',
    ]);
  });

  it('preserves the live Viction legacy ICA owner', () => {
    expect(environments.mainnet3.core.viction.owner).to.equal(
      '0x426FC4C5CC60E5e47101fe30d4f8B94F1b7C1C70',
    );
    expect(environments.mainnet3.core.viction.ownerOverrides?.mailbox).to.be
      .undefined;
  });

  it('preserves both MerkleTreeHooks in the Metis hook topology', () => {
    const defaultHook = environments.mainnet3.core.metis.defaultHook;
    assert(
      typeof defaultHook !== 'string' &&
        defaultHook.type === HookType.FALLBACK_ROUTING,
      'Expected a recovered Metis fallback routing hook',
    );
    expect(defaultHook.fallback).to.equal(
      '0x5F954cA945671e48466680eA815727948Ca340ef',
    );
    const aggregationHook = Object.values(defaultHook.domains)[0];
    assert(
      typeof aggregationHook !== 'string' &&
        aggregationHook.type === HookType.AGGREGATION,
      'Expected a recovered Metis aggregation hook',
    );
    expect(aggregationHook.hooks).to.include(
      '0xF5da68b2577EF5C0A0D98aA2a58483a68C2f232a',
    );
  });
});
