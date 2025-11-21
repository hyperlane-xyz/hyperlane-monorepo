import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { IProvider, ISigner, IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DerivedIsmConfig,
  IsmConfig,
  IsmModuleType,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  HypModule,
  HypModuleArgs,
  HypReader,
  ModuleProvider,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { assert } from '@hyperlane-xyz/utils';

import { DEFAULT_APPLICATION_NAME, DEFAULT_GAS_MULTIPLIER } from '../const.js';
import { RadixBase } from '../utils/base.js';

import {
  RadixMultisigIsmModule,
  RadixMultisigIsmReader,
} from './multisig-ism.js';
import { RadixRoutingIsmModule, RadixRoutingIsmReader } from './routing-ism.js';
import { RadixTestIsmModule, RadixTestIsmReader } from './test-ism.js';
import { RadixRoutingIsmTx } from './tx.js';

class RadixIsmModuleProvider implements ModuleProvider<IsmModuleType> {
  constructor(
    private readonly radixNetworkId: number,
    private readonly chainLookup: ChainLookup,
    private readonly base: RadixBase,
    private readonly gateway: GatewayApiClient,
  ) {}

  connectReader(provider: IProvider): HypReader<IsmModuleType> {
    return {
      read: async (address: string): Promise<DerivedIsmConfig> => {
        const ismType = await provider.getIsmType({ ismAddress: address });

        switch (ismType) {
          case IsmType.MESSAGE_ID_MULTISIG:
          case IsmType.MERKLE_ROOT_MULTISIG:
            return new RadixMultisigIsmReader(this.gateway).read(address);

          case IsmType.TEST_ISM:
            return new RadixTestIsmReader(provider).read(address);

          case IsmType.ROUTING: {
            return new RadixRoutingIsmReader(provider, this.gateway, this).read(
              address,
            );
          }

          default:
            throw new Error(`Unsupported ISM type: ${ismType}`);
        }
      },
    };
  }

  connectModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    args: HypModuleArgs<IsmModuleType>,
  ): HypModule<IsmModuleType> {
    const { config, addresses, chain } = args;

    assert(typeof config !== 'string', 'Expected ISM config to be an object');

    switch (config.type) {
      case IsmType.MESSAGE_ID_MULTISIG:
      case IsmType.MERKLE_ROOT_MULTISIG:
        return new RadixMultisigIsmModule(
          { addresses, chain, config },
          new RadixMultisigIsmReader(this.gateway),
        );

      case IsmType.TEST_ISM:
        return new RadixTestIsmModule(
          { addresses, chain, config },
          new RadixTestIsmReader(signer),
        );

      case IsmType.ROUTING: {
        return new RadixRoutingIsmModule(
          this.radixNetworkId,
          this.chainLookup,
          { addresses, chain, config },
          new RadixRoutingIsmReader(signer, this.gateway, this),
          new RadixRoutingIsmTx(this.base),
          this,
          signer,
        );
      }

      default:
        throw new Error(`Unsupported ISM type: ${(config as IsmConfig).type}`);
    }
  }

  async createModule(
    _signer: ISigner<AnnotatedTx, TxReceipt>,
    _config: IsmConfig,
  ): Promise<HypModule<IsmModuleType>> {
    throw new Error(
      'ISM deployment not yet implemented. Will be added in follow-up PR. ' +
        'For now, use string addresses for nested ISMs in routing configs.',
    );
  }
}

export function radixIsmModuleProvider(
  chainLookup: ChainLookup,
  chainName: string,
): ModuleProvider<IsmModuleType> {
  const { chainId: radixNetworkId, gatewayUrls } =
    chainLookup.getChainMetadata(chainName);

  const parsedRadixNetworkId = parseInt(radixNetworkId.toString());
  assert(
    !isNaN(parsedRadixNetworkId),
    `Invalid Radix network ID: ${radixNetworkId}`,
  );

  const gateway = GatewayApiClient.initialize({
    applicationName: DEFAULT_APPLICATION_NAME,
    basePath: gatewayUrls?.[0]?.http,
    networkId: parsedRadixNetworkId,
  });

  const base = new RadixBase(
    parsedRadixNetworkId,
    gateway,
    DEFAULT_GAS_MULTIPLIER,
  );

  return new RadixIsmModuleProvider(
    parsedRadixNetworkId,
    chainLookup,
    base,
    gateway,
  );
}
