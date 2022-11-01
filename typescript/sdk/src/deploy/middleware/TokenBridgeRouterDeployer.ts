import { ethers } from 'hardhat';

import {
  CircleBridgeAdapter__factory,
  TokenBridgeRouter__factory,
} from '@hyperlane-xyz/core';
import { objMap, promiseObjAll } from '@hyperlane-xyz/sdk/src/utils/objects';
import { utils } from '@hyperlane-xyz/utils';

import { chainMetadata } from '../../consts/chainMetadata';
import { HyperlaneCore } from '../../core/HyperlaneCore';
import { MultiProvider } from '../../providers/MultiProvider';
import {
  TokenBridgeContracts,
  TokenBridgeFactories,
  tokenBridgeFactories,
} from '../../tokenBridge';
import { ChainMap, ChainName } from '../../types';
import { HyperlaneRouterDeployer } from '../router/HyperlaneRouterDeployer';
import { RouterConfig } from '../router/types';

export enum BridgeAdapterType {
  Mock = 'Mock',
  Circle = 'Circle',
}

export interface CircleBridgeAdapterConfig {
  type: BridgeAdapterType.Circle;
  circleBridgeAddress: string;
  messageTransmitterAddress: string;
  usdcAddress: string;
  circleDomainMapping: {
    hyperlaneDomain: number;
    circleDomain: number;
  }[];
}

interface MockTokenBridgeAdapterConfig {
  type: BridgeAdapterType.Mock;
  mockTokenAddress: string;
}

export type BridgeAdapterConfig =
  | CircleBridgeAdapterConfig
  | MockTokenBridgeAdapterConfig;

export type TokenBridgeConfig = RouterConfig & {
  bridgeAdapterConfigs: BridgeAdapterConfig[];
};

export class TokenBridgeDeployer<
  Chain extends ChainName,
> extends HyperlaneRouterDeployer<
  Chain,
  TokenBridgeConfig,
  TokenBridgeContracts,
  TokenBridgeFactories
> {
  constructor(
    multiProvider: MultiProvider<Chain>,
    configMap: ChainMap<Chain, TokenBridgeConfig>,
    protected core: HyperlaneCore<Chain>,
    protected create2salt = 'tokenbridgedeployersalt',
  ) {
    super(multiProvider, configMap, tokenBridgeFactories, {});
  }

  async enrollRemoteRouters(
    contractsMap: ChainMap<Chain, TokenBridgeContracts>,
  ): Promise<void> {
    // Enroll the TokenBridgeRouter with each other
    await super.enrollRemoteRouters(contractsMap);

    // Enroll the circle adapters with each other
    const deployedChains = Object.keys(contractsMap);
    await promiseObjAll(
      objMap(contractsMap, async (local, contracts) => {
        const chainConnection = this.multiProvider.getChainConnection(local);
        // only enroll chains which are deployed
        const enrollChains = this.multiProvider
          .remoteChains(local)
          .filter((c) => deployedChains.includes(c));
        for (const remote of enrollChains) {
          const remoteDomain = chainMetadata[remote].id;
          if (
            !contracts.circleBridgeAdapter ||
            !contractsMap[remote].circleBridgeAdapter
          ) {
            continue;
          }
          const current = await contracts.circleBridgeAdapter.routers(
            remoteDomain,
          );
          const expected = utils.addressToBytes32(
            contractsMap[remote].circleBridgeAdapter!.address,
          );
          if (current !== expected) {
            await super.runIfOwner(
              local,
              contracts.circleBridgeAdapter,
              async () => {
                this.logger(
                  `Enroll ${remote}'s CircleBridgeAdapter on ${local}`,
                );
                await chainConnection.handleTx(
                  contracts.circleBridgeAdapter!.enrollRemoteRouter(
                    chainMetadata[remote].id,
                    expected,
                    chainConnection.overrides,
                  ),
                );
              },
            );
          }
        }
      }),
    );
  }

  // Custom contract deployment logic can go here
  // If no custom logic is needed, call deployContract for the router
  async deployContracts(
    chain: Chain,
    config: TokenBridgeConfig,
  ): Promise<TokenBridgeContracts> {
    const cc = this.multiProvider.getChainConnection(chain);
    const initCalldata =
      TokenBridgeRouter__factory.createInterface().encodeFunctionData(
        'initialize',
        [config.owner, config.connectionManager, config.interchainGasPaymaster],
      );
    const router = await this.deployContract(chain, 'router', [], {
      create2Salt: this.create2salt + 'TokenBridgeRouter',
      initCalldata,
    });

    const bridgeAdapters: Partial<TokenBridgeContracts> = {};

    for (const adapterConfig of config.bridgeAdapterConfigs) {
      switch (adapterConfig.type) {
        case BridgeAdapterType.Circle:
          const initCalldata =
            CircleBridgeAdapter__factory.createInterface().encodeFunctionData(
              'initialize',
              [
                config.owner,
                adapterConfig.circleBridgeAddress,
                adapterConfig.messageTransmitterAddress,
                router.address,
              ],
            );
          const circleBridgeAdapter = await this.deployContract(
            chain,
            'circleBridgeAdapter',
            [],
            {
              create2Salt: this.create2salt + 'CircleBridgeAdapter',
              initCalldata,
            },
          );

          if (
            (await circleBridgeAdapter.tokenSymbolToToken('USDC')) ===
            ethers.constants.AddressZero
          ) {
            this.logger(`Set USDC token contract`);
            await cc.handleTx(
              circleBridgeAdapter.addTokenAndTokenSymbol(
                adapterConfig.usdcAddress,
                'USDC',
              ),
            );
          }

          // Set domain mappings
          for (const {
            circleDomain,
            hyperlaneDomain,
          } of adapterConfig.circleDomainMapping) {
            const expectedCircleDomain =
              await circleBridgeAdapter.hyperlaneDomainToCircleDomain(
                hyperlaneDomain,
              );
            if (expectedCircleDomain !== circleDomain) {
              this.logger(
                `Set circle domain ${circleDomain} for hyperlane domain ${hyperlaneDomain}`,
              );
              await cc.handleTx(
                circleBridgeAdapter.setHyperlaneDomainToCircleDomain(
                  hyperlaneDomain,
                  circleDomain,
                ),
              );
            }
          }

          this.logger('Set CircleTokenBridgeAdapter on Router');
          await cc.handleTx(
            router.setTokenBridgeAdapter(
              adapterConfig.type,
              circleBridgeAdapter.address,
            ),
          );
          bridgeAdapters.circleBridgeAdapter = circleBridgeAdapter;
          break;
        case BridgeAdapterType.Mock:
          const mockBridgeAdapter = await this.deployContract(
            chain,
            'mockBridgeAdapter',
            [adapterConfig.mockTokenAddress],
          );
          await cc.handleTx(
            router.setTokenBridgeAdapter(
              adapterConfig.type,
              mockBridgeAdapter.address,
            ),
          );
          bridgeAdapters.mockBridgeAdapter = mockBridgeAdapter;
          break;
        default:
          break;
      }
    }

    return {
      ...bridgeAdapters,
      router,
    };
  }
}
