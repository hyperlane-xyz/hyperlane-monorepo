import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { IProvider, ISigner, IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DerivedIsmConfig,
  DomainRoutingIsmConfig,
  ExtractIsmModuleType,
  IsmConfig,
  IsmModuleAddresses,
  IsmModuleType,
  calculateDomainRoutingIsmDelta,
  extractIsmAddress,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  HypModule,
  HypModuleArgs,
  HypReader,
  ModuleProvider,
  ReaderProvider,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import { WithAddress, assert, eqAddressRadix } from '@hyperlane-xyz/utils';

import { RadixBase } from '../utils/base.js';
import {
  AnnotatedRadixTransaction,
  RadixNetworkConfig,
  RadixSDKReceipt,
} from '../utils/types.js';

import { getDomainRoutingIsmConfig } from './query.js';
import { RadixRoutingIsmTx } from './tx.js';

type RoutingIsmModule = ExtractIsmModuleType<'domainRoutingIsm'>;

export class RadixRoutingIsmReader implements HypReader<RoutingIsmModule> {
  constructor(
    private readonly provider: IProvider,
    private readonly radixGateway: GatewayApiClient,
    private readonly readerProvider: ReaderProvider<IsmModuleType>,
  ) {}

  async read(address: string): Promise<WithAddress<DomainRoutingIsmConfig>> {
    const { owner, routes } = await getDomainRoutingIsmConfig(
      this.radixGateway,
      address,
    );

    const ismReader = this.readerProvider.connectReader(this.provider);

    const domains: Record<string, DerivedIsmConfig> = {};
    for (const route of routes) {
      domains[route.domainId.toString()] = await ismReader.read(
        route.ismAddress,
      );
    }

    return {
      address,
      type: IsmType.ROUTING,
      owner,
      domains,
    };
  }
}

export class RadixRoutingIsmModule implements HypModule<RoutingIsmModule> {
  constructor(
    private readonly radixNetworkId: number,
    private readonly chainLookup: ChainLookup,
    private readonly args: HypModuleArgs<RoutingIsmModule>,
    private readonly reader: HypReader<RoutingIsmModule>,
    private readonly txHelper: RadixRoutingIsmTx,
    private readonly moduleProvider: ModuleProvider<IsmModuleType>,
    private readonly signer: ISigner<AnnotatedTx, TxReceipt>,
  ) {}

  read(): Promise<WithAddress<DomainRoutingIsmConfig>> {
    return this.reader.read(this.args.addresses.deployedIsm);
  }

  serialize(): IsmModuleAddresses {
    return this.args.addresses;
  }

  static async create(
    ismConfig: DomainRoutingIsmConfig,
    networkConfig: RadixNetworkConfig,
    chainLookup: ChainLookup,
    signer: ISigner<AnnotatedTx, TxReceipt>,
    base: RadixBase,
    gateway: GatewayApiClient,
    moduleProvider: ModuleProvider<IsmModuleType>,
  ): Promise<HypModule<RoutingIsmModule>> {
    const { chainName, hyperlanePackageAddress, radixNetworkId } =
      networkConfig;

    const txHelper = new RadixRoutingIsmTx(
      {
        chainName,
        hyperlanePackageAddress,
        radixNetworkId,
      },
      base,
    );

    const routes: { domainId: number; ismAddress: string }[] = [];
    for (const [chainNameOrId, domainConfig] of Object.entries(
      ismConfig.domains,
    )) {
      const domainId = chainLookup.getDomainId(chainNameOrId);
      assert(
        domainId,
        `Expected domainId to be defined for chain ${chainNameOrId}`,
      );

      let targetIsmAddress: string;
      if (typeof domainConfig === 'string' || 'address' in domainConfig) {
        targetIsmAddress = extractIsmAddress(
          domainConfig as string | DerivedIsmConfig,
        );
      } else {
        const nestedModule = await moduleProvider.createModule(
          signer,
          domainConfig,
        );
        targetIsmAddress = nestedModule.serialize().deployedIsm;
      }

      routes.push({
        domainId: parseInt(domainId.toString()),
        ismAddress: targetIsmAddress,
      });
    }

    const deployTransaction = await txHelper.buildDeploymentTx(
      signer.getSignerAddress(),
      routes,
    );

    const res = await signer.sendAndConfirmTransaction(deployTransaction);

    const address = await base.getNewComponent(res as RadixSDKReceipt);

    return new RadixRoutingIsmModule(
      radixNetworkId,
      chainLookup,
      {
        addresses: {
          deployedIsm: address,
          mailbox: '',
        },
        chain: chainName,
        config: ismConfig,
      },
      new RadixRoutingIsmReader(signer, gateway, moduleProvider),
      txHelper,
      moduleProvider,
      signer,
    );
  }

  async update(
    expectedConfig: DomainRoutingIsmConfig,
  ): Promise<AnnotatedRadixTransaction[]> {
    const actualConfig = await this.read();

    const transactions: AnnotatedRadixTransaction[] = [];

    const updateDomainIsmTxs = await this.createRouteUpdateTxs(
      actualConfig,
      expectedConfig,
    );
    transactions.push(...updateDomainIsmTxs);

    // Update owner last as previous updates need to be executed
    // by the current owner
    const updateOwnerTxs = await this.createOwnerUpdateTxs(
      actualConfig,
      expectedConfig,
    );
    transactions.push(...updateOwnerTxs);

    return transactions;
  }

  private async createOwnerUpdateTxs(
    actualConfig: WithAddress<DomainRoutingIsmConfig>,
    expectedConfig: DomainRoutingIsmConfig,
  ): Promise<AnnotatedRadixTransaction[]> {
    if (eqAddressRadix(actualConfig.owner, expectedConfig.owner)) {
      return [];
    }

    const ismAddress = this.args.addresses.deployedIsm;

    const manifest = await this.txHelper.buildUpdateOwnershipTransaction({
      from_address: actualConfig.owner,
      ism: ismAddress,
      new_owner: expectedConfig.owner,
    });

    return [
      {
        annotation: `Transferring ownership of RoutingIsm ${ismAddress} from ${actualConfig.owner} to ${expectedConfig.owner}`,
        networkId: this.radixNetworkId,
        manifest,
      },
    ];
  }

  private normalizeDomainKeys(
    config: DomainRoutingIsmConfig,
  ): DomainRoutingIsmConfig {
    const normalizedDomains: Record<string, IsmConfig | string> = {};

    for (const chainNameOrId of Object.keys(config.domains)) {
      const domainId = this.chainLookup.getDomainId(chainNameOrId);
      assert(
        domainId,
        `Expected domainId to be defined for chain ${chainNameOrId}`,
      );

      normalizedDomains[domainId.toString()] = config.domains[chainNameOrId];
    }

    return {
      ...config,
      domains: normalizedDomains,
    };
  }

  private async createRouteUpdateTxs(
    actualConfig: WithAddress<DomainRoutingIsmConfig>,
    expectedConfig: DomainRoutingIsmConfig,
  ): Promise<AnnotatedRadixTransaction[]> {
    const transactions: AnnotatedRadixTransaction[] = [];

    const normalizedActual = this.normalizeDomainKeys(actualConfig);
    const normalizedExpected = this.normalizeDomainKeys(expectedConfig);

    const { domainsToEnroll, domainsToUnenroll } =
      calculateDomainRoutingIsmDelta(normalizedActual, normalizedExpected);

    const owner = actualConfig.owner;

    const [unenrollTxs, enrollTxs] = await Promise.all([
      Promise.all(
        domainsToUnenroll.map((domainId) =>
          this.createRemoveRouteTx(parseInt(domainId), owner),
        ),
      ),
      Promise.all(
        domainsToEnroll.map((domainId) =>
          this.createSetRouteTx(
            parseInt(domainId),
            normalizedExpected.domains[domainId],
            owner,
          ),
        ),
      ),
    ]);

    transactions.push(...unenrollTxs, ...enrollTxs);

    return transactions;
  }

  private async createRemoveRouteTx(
    domainId: number,
    owner: string,
  ): Promise<AnnotatedRadixTransaction> {
    const ismAddress = this.args.addresses.deployedIsm;

    const manifest = await this.txHelper.buildRemoveDomainIsmTransaction({
      from_address: owner,
      ism: ismAddress,
      domain: domainId,
    });

    return {
      annotation: `Removing route for domain ${domainId} from RoutingIsm ${ismAddress}`,
      networkId: this.radixNetworkId,
      manifest,
    };
  }

  private async createSetRouteTx(
    domainId: number,
    domainConfig: string | IsmConfig | DerivedIsmConfig,
    owner: string,
  ): Promise<AnnotatedRadixTransaction> {
    const ismAddress = this.args.addresses.deployedIsm;

    let targetIsmAddress: string;
    if (typeof domainConfig === 'string' || 'address' in domainConfig) {
      targetIsmAddress = extractIsmAddress(domainConfig);
    } else {
      const nestedModule = await this.moduleProvider.createModule(
        this.signer,
        domainConfig,
      );
      targetIsmAddress = nestedModule.serialize().deployedIsm;
    }

    const manifest = await this.txHelper.buildAddDomainIsmTransaction({
      from_address: owner,
      ism: ismAddress,
      route: {
        domainId,
        ismAddress: targetIsmAddress,
      },
    });

    return {
      annotation: `Setting route for domain ${domainId} to ISM ${targetIsmAddress} on RoutingIsm ${ismAddress}`,
      networkId: this.radixNetworkId,
      manifest,
    };
  }
}
