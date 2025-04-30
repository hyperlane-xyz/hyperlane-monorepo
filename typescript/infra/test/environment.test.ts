import { expect } from 'chai';

import {
  AggregationIsmConfig,
  ChainTechnicalStack,
  CoreConfig,
  DomainRoutingIsmConfig,
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
          const expectedChains = supportedChainNames.filter((c) => c !== chain);

          // Verify no unexpected chains in domains
          expect(Object.keys(routingIsmDomains)).to.have.lengthOf(
            expectedChains.length,
          );
          expect(Object.keys(routingIsmDomains)).to.not.include(chain);

          // Verify each expected chain has an entry in the domains
          for (const expectedChain of expectedChains) {
            expect(routingIsmDomains[expectedChain]).to.not.be.undefined;
          }
        }
      });
    });
  }
});
