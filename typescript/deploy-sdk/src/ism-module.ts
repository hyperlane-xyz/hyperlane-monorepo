import { IProvider, ISigner } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  ChainLookup,
  ChainMetadataForAltVM,
} from '@hyperlane-xyz/provider-sdk/chain';
import {
  DerivedIsmConfig,
  IsmConfig,
  IsmModuleAddresses,
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

import { AltVMIsmModule } from './AltVMIsmModule.js';
import { createIsmReader } from './ism/generic-ism.js';

/**
 * Adapter that wraps GenericIsmReader to implement HypReader interface.
 * This bridges the Artifact API (used by GenericIsmReader) with the Config API
 * (expected by HypReader).
 */
class IsmReaderAdapter implements HypReader<IsmModuleType> {
  private readonly reader;

  constructor(chainMetadata: ChainMetadataForAltVM, chainLookup: ChainLookup) {
    this.reader = createIsmReader(chainMetadata, chainLookup);
  }

  async read(address: string): Promise<DerivedIsmConfig> {
    return this.reader.deriveIsmConfig(address);
  }
}

class IsmModuleProvider implements ModuleProvider<IsmModuleType> {
  constructor(
    private chainLookup: ChainLookup,
    private chainMetadata: ChainMetadataForAltVM,
    private mailboxAddress: string,
  ) {}

  async createModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    config: IsmConfig,
  ): Promise<HypModule<IsmModuleType>> {
    const addresses: IsmModuleAddresses = {
      deployedIsm: '', // Will be populated by the module
      mailbox: this.mailboxAddress,
    };

    return await AltVMIsmModule.create({
      chainLookup: this.chainLookup,
      chain: this.chainMetadata.name,
      signer,
      config,
      addresses,
    });
  }

  connectModule(
    signer: ISigner<AnnotatedTx, TxReceipt>,
    args: HypModuleArgs<IsmModuleType>,
  ): HypModule<IsmModuleType> {
    return new AltVMIsmModule(this.chainLookup, args, signer);
  }

  connectReader(_provider: IProvider<any>): HypReader<IsmModuleType> {
    return new IsmReaderAdapter(this.chainMetadata, this.chainLookup);
  }
}

export function ismModuleProvider(
  chainLookup: ChainLookup,
  chainMetadata: ChainMetadataForAltVM,
  mailboxAddress: string,
): ModuleProvider<IsmModuleType> {
  return new IsmModuleProvider(chainLookup, chainMetadata, mailboxAddress);
}
