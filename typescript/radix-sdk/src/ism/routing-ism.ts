import { GatewayApiClient } from '@radixdlt/babylon-gateway-api-sdk';

import { IProvider, ISigner, IsmType } from '@hyperlane-xyz/provider-sdk/altvm';
import {
  DerivedIsmConfig,
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmModuleAddresses,
  IsmModuleType,
  calculateDomainRoutingIsmDelta,
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
import { WithAddress, eqAddressRadix } from '@hyperlane-xyz/utils';

import { getDomainRoutingIsmConfig } from './query.js';
import { RadixRoutingIsmTx } from './tx.js';

type RoutingIsmModule = {
  config: DomainRoutingIsmConfig;
  addresses: IsmModuleAddresses;
  derived: WithAddress<DomainRoutingIsmConfig>;
};

export class RadixRoutingIsmReader implements HypReader<RoutingIsmModule> {
  constructor(
    private readonly provider: IProvider,
    private readonly radixGateway: GatewayApiClient,
    private readonly readerProvider: ReaderProvider<IsmModuleType>,
  ) {}

  async read(address: string): Promise<WithAddress<DomainRoutingIsmConfig>> {
    const { owner, routes } = await getDomainRoutingIsmConfig(
      this.radixGateway,
      { ism: address },
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

  async update(expectedConfig: DomainRoutingIsmConfig): Promise<AnnotatedTx[]> {
    const actualConfig = await this.read();

    const transactions: AnnotatedTx[] = [];

    const updateDomainIsmTxs = await this.createRouteUpdateTxs(
      actualConfig,
      expectedConfig,
    );
    transactions.push(...updateDomainIsmTxs);

    // Update owner last as previous updates need to be executed
    // by the current owner
    const updateOwnerTx = await this.createOwnerUpdateTxs(
      actualConfig,
      expectedConfig,
    );
    transactions.push(updateOwnerTx);

    return transactions;
  }

  private async createOwnerUpdateTxs(
    actualConfig: WithAddress<DomainRoutingIsmConfig>,
    expectedConfig: DomainRoutingIsmConfig,
  ): Promise<AnnotatedTx> {
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

  private async createRouteUpdateTxs(
    actualConfig: WithAddress<DomainRoutingIsmConfig>,
    expectedConfig: DomainRoutingIsmConfig,
  ): Promise<AnnotatedTx[]> {
    const transactions: AnnotatedTx[] = [];

    const { domainsToEnroll, domainsToUnenroll } =
      calculateDomainRoutingIsmDelta(actualConfig, expectedConfig);

    const owner = actualConfig.owner;

    for (const domain of domainsToUnenroll) {
      const tx = await this.createRemoveRouteTx(domain, owner);
      transactions.push(tx);
    }

    for (const domain of domainsToEnroll) {
      const tx = await this.createSetRouteTx(
        domain,
        expectedConfig.domains[domain],
        owner,
      );
      transactions.push(tx);
    }

    return transactions;
  }

  private async createRemoveRouteTx(
    domain: string,
    owner: string,
  ): Promise<AnnotatedTx> {
    const ismAddress = this.args.addresses.deployedIsm;

    const manifest = await this.txHelper.buildRemoveDomainIsmTransaction({
      from_address: owner,
      ism: ismAddress,
      domain: parseInt(domain),
    });

    return {
      annotation: `Removing route for domain ${domain} from RoutingIsm ${ismAddress}`,
      networkId: this.radixNetworkId,
      manifest,
    };
  }

  private async createSetRouteTx(
    domain: string,
    domainConfig: string | IsmConfig,
    owner: string,
  ): Promise<AnnotatedTx> {
    const ismAddress = this.args.addresses.deployedIsm;

    let targetIsmAddress: string;
    if (typeof domainConfig === 'string') {
      targetIsmAddress = domainConfig;
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
        domainId: parseInt(domain),
        ismAddress: targetIsmAddress,
      },
    });

    return {
      annotation: `Setting route for domain ${domain} to ISM ${targetIsmAddress} on RoutingIsm ${ismAddress}`,
      networkId: this.radixNetworkId,
      manifest,
    };
  }
}
