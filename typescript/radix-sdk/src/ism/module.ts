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

import {
  DEFAULT_GAS_MULTIPLIER,
  getRadixHyperlanePackageDef,
} from '../const.js';
import { RadixBase } from '../utils/base.js';
import { RadixNetworkConfig } from '../utils/types.js';

import {
  RadixMultisigIsmModule,
  RadixMultisigIsmReader,
} from './multisig-ism.js';
import { RadixRoutingIsmModule, RadixRoutingIsmReader } from './routing-ism.js';
import { RadixTestIsmModule, RadixTestIsmReader } from './test-ism.js';
import { RadixRoutingIsmTx } from './tx.js';

class RadixIsmModuleProvider implements ModuleProvider<IsmModuleType> {
  constructor(
    private readonly config: RadixNetworkConfig,
    private readonly chainLookup: ChainLookup,
    private readonly base: RadixBase,
    private readonly gateway: GatewayApiClient,
  ) {}

  connectReader(provider: IProvider): HypReader<IsmModuleType> {
    return {
      read: async (address: string): Promise<DerivedIsmConfig> => {
        const ismType = await provider.getIsmType({ ismAddress: address });

        let ismReader: HypReader<IsmModuleType>;
        switch (ismType) {
          case IsmType.MESSAGE_ID_MULTISIG:
          case IsmType.MERKLE_ROOT_MULTISIG:
            ismReader = new RadixMultisigIsmReader(this.gateway);
            break;

          case IsmType.TEST_ISM:
            ismReader = new RadixTestIsmReader(provider);
            break;

          case IsmType.ROUTING:
            {
              ismReader = new RadixRoutingIsmReader(
                provider,
                this.gateway,
                this,
              );
            }
            break;

          default:
            throw new Error(`Unsupported ISM type: ${ismType}`);
        }

        return ismReader.read(address);
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
          signer,
          new RadixMultisigIsmReader(this.gateway),
          this,
        );

      case IsmType.TEST_ISM:
        return new RadixTestIsmModule(
          { addresses, chain, config },
          new RadixTestIsmReader(signer),
        );

      case IsmType.ROUTING: {
        return new RadixRoutingIsmModule(
          this.config.radixNetworkId,
          this.chainLookup,
          { addresses, chain, config },
          new RadixRoutingIsmReader(signer, this.gateway, this),
          new RadixRoutingIsmTx(this.config, this.base),
          this,
          signer,
        );
      }

      default:
        throw new Error(`Unsupported ISM type: ${(config as IsmConfig).type}`);
    }
  }

  async createModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    config: IsmConfig,
  ): Promise<HypModule<IsmModuleType>> {
    switch (config.type) {
      case IsmType.TEST_ISM:
        return RadixTestIsmModule.create(
          config,
          this.config,
          signer,
          this.base,
        );

      case IsmType.MESSAGE_ID_MULTISIG:
      case IsmType.MERKLE_ROOT_MULTISIG:
        return RadixMultisigIsmModule.create(
          config,
          this.config,
          signer,
          this.base,
          this.gateway,
          this,
        );

      case IsmType.ROUTING:
        return RadixRoutingIsmModule.create(
          config,
          this.config,
          this.chainLookup,
          signer,
          signer,
          this.base,
          this.gateway,
          this,
        );

      default:
        throw new Error(`Unsupported ISM type for deployment: ${config.type}`);
    }
  }
}

export function radixIsmModuleProvider(
  chainLookup: ChainLookup,
  chainName: string,
): ModuleProvider<IsmModuleType> {
  const {
    chainId: radixNetworkId,
    gatewayUrls,
    packageAddress,
  } = chainLookup.getChainMetadata(chainName);

  const parsedRadixNetworkId = parseInt(radixNetworkId.toString());
  assert(
    !isNaN(parsedRadixNetworkId),
    `Invalid Radix network ID: ${radixNetworkId}`,
  );

  const hyperlanePackageDef = getRadixHyperlanePackageDef({
    networkId: parsedRadixNetworkId,
    packageAddress,
  });

  const gateway = GatewayApiClient.initialize({
    applicationName: hyperlanePackageDef.applicationName,
    basePath: gatewayUrls?.[0]?.http,
    networkId: parsedRadixNetworkId,
  });

  const base = new RadixBase(
    parsedRadixNetworkId,
    gateway,
    DEFAULT_GAS_MULTIPLIER,
  );

  return new RadixIsmModuleProvider(
    {
      chainName,
      hyperlanePackageAddress: hyperlanePackageDef.packageAddress,
      radixNetworkId: parsedRadixNetworkId,
    },
    chainLookup,
    base,
    gateway,
  );
}
