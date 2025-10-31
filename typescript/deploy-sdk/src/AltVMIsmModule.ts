import { Logger } from 'pino';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ChainLookup } from '@hyperlane-xyz/provider-sdk/chain';
import {
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmType,
  MultisigIsmConfig,
  STATIC_ISM_TYPES,
} from '@hyperlane-xyz/provider-sdk/ism';
import {
  AnnotatedTx,
  HypModule,
  HypModuleArgs,
  TxReceipt,
} from '@hyperlane-xyz/provider-sdk/module';
import {
  Address,
  assert,
  deepEquals,
  intersection,
  normalizeConfig,
  rootLogger,
  sleep,
} from '@hyperlane-xyz/utils';

import { AltVMIsmReader } from './AltVMIsmReader.js';

type IsmModuleAddresses = {
  deployedIsm: Address;
  mailbox: Address;
};

// Determines the domains to enroll and unenroll to update the current ISM config
// to match the target ISM config.
function calculateDomainRoutingDelta(
  current: DomainRoutingIsmConfig,
  target: DomainRoutingIsmConfig,
): { domainsToEnroll: string[]; domainsToUnenroll: string[] } {
  const domainsToEnroll = [];
  for (const origin of Object.keys(target.domains)) {
    if (!current.domains[origin]) {
      domainsToEnroll.push(origin);
    } else {
      const subModuleMatches = deepEquals(
        current.domains[origin],
        target.domains[origin],
      );
      if (!subModuleMatches) domainsToEnroll.push(origin);
    }
  }

  const domainsToUnenroll = Object.keys(current.domains).reduce(
    (acc, origin) => {
      if (!Object.keys(target.domains).includes(origin)) {
        acc.push(origin);
      }
      return acc;
    },
    [] as string[],
  );

  return {
    domainsToEnroll,
    domainsToUnenroll,
  };
}

export class AltVMIsmModule
  implements HypModule<IsmConfig, IsmModuleAddresses>
{
  protected readonly logger = rootLogger.child({
    module: 'AltVMIsmModule',
  });
  protected readonly reader: AltVMIsmReader;
  protected readonly mailbox: Address;

  // Cached chain name
  public readonly chain: string;

  constructor(
    protected readonly chainLookup: ChainLookup,
    private readonly args: HypModuleArgs<
      IsmConfig | string,
      IsmModuleAddresses
    >,
    protected readonly signer: AltVM.ISigner<AnnotatedTx, TxReceipt>,
  ) {
    this.mailbox = this.args.addresses.mailbox;
    const metadata = chainLookup.getChainMetadata(this.args.chain);
    this.chain = metadata.name;

    this.reader = new AltVMIsmReader(chainLookup.getChainName, this.signer);
  }

  public async read(): Promise<IsmConfig> {
    return this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  public serialize(): IsmModuleAddresses {
    return this.args.addresses;
  }

  // whoever calls update() needs to ensure that targetConfig has a valid owner
  public async update(
    expectedConfig: IsmConfig | string,
  ): Promise<AnnotatedTx[]> {
    // Do not support updating to a custom ISM address
    if (typeof expectedConfig === 'string') {
      throw new Error(
        'Invalid targetConfig: Updating to a custom ISM address is not supported. Please provide a valid ISM configuration.',
      );
    }

    // if there is no ism deployed yet we deploy one
    if (!this.args.addresses.deployedIsm) {
      this.args.addresses.deployedIsm = await this.deploy({
        config: expectedConfig,
      });

      return [];
    }

    // save current config for comparison
    // normalize the config to ensure it's in a consistent format for comparison
    const actualConfig = normalizeConfig(await this.read());
    expectedConfig = normalizeConfig(expectedConfig);

    assert(
      typeof expectedConfig === 'object',
      'normalized expectedConfig should be an object',
    );

    // Update the config
    this.args.config = expectedConfig;

    // If configs match, no updates needed
    if (deepEquals(actualConfig, expectedConfig)) {
      return [];
    }

    // if the ISM is a static ISM we can not update it, instead
    // it needs to be recreated with the expected config
    if (STATIC_ISM_TYPES.includes(expectedConfig.type)) {
      this.args.addresses.deployedIsm = await this.deploy({
        config: expectedConfig,
      });

      return [];
    }

    let updateTxs: AnnotatedTx[] = [];
    if (expectedConfig.type === 'domainRoutingIsm') {
      const logger = this.logger.child({
        destination: this.chain,
        ismType: expectedConfig.type,
      });
      logger.debug(`Updating ${expectedConfig.type} on ${this.chain}`);

      updateTxs = await this.updateRoutingIsm({
        actual: actualConfig,
        expected: expectedConfig,
        logger,
      });
    }

    return updateTxs;
  }

  // manually write static create function
  public static async create({
    chain,
    config,
    addresses,
    chainLookup,
    signer,
  }: {
    chain: string;
    config: IsmConfig | string;
    addresses: {
      mailbox: string;
    };
    chainLookup: ChainLookup;
    signer: AltVM.ISigner<AnnotatedTx, TxReceipt>;
  }): Promise<AltVMIsmModule> {
    const module = new AltVMIsmModule(
      chainLookup,
      {
        addresses: {
          ...addresses,
          deployedIsm: '',
        },
        chain,
        config,
      },
      signer,
    );

    module.args.addresses.deployedIsm = await module.deploy({ config });
    return module;
  }

  protected async deploy({
    config,
  }: {
    config: IsmConfig | string;
  }): Promise<Address> {
    if (typeof config === 'string') {
      return config;
    }
    const ismType = config.type;
    this.logger.info(`Deploying ${ismType} to ${this.chain}`);

    switch (ismType) {
      case 'merkleRootMultisigIsm': {
        return this.deployMerkleRootMultisigIsm(config);
      }
      case 'messageIdMultisigIsm': {
        return this.deployMessageIdMultisigIsm(config);
      }
      case 'domainRoutingIsm': {
        return this.deployRoutingIsm(config);
      }
      case 'testIsm': {
        return this.deployNoopIsm();
      }
      default:
        throw new Error(
          `ISM type ${ismType as IsmType} is not supported on AltVM`,
        );
    }
  }

  protected async deployMerkleRootMultisigIsm(
    config: MultisigIsmConfig,
  ): Promise<Address> {
    assert(
      config.threshold <= config.validators.length,
      `threshold (${config.threshold}) for merkle root multisig ISM is greater than number of validators (${config.validators.length})`,
    );
    const { ismAddress } = await this.signer.createMerkleRootMultisigIsm({
      validators: config.validators,
      threshold: config.threshold,
    });

    this.logger.debug(`Deployed merkle root multisig ISM to ${ismAddress}`);
    return ismAddress;
  }

  protected async deployMessageIdMultisigIsm(
    config: MultisigIsmConfig,
  ): Promise<Address> {
    assert(
      config.threshold <= config.validators.length,
      `threshold (${config.threshold}) for message id multisig ISM is greater than number of validators (${config.validators.length})`,
    );
    const { ismAddress } = await this.signer.createMessageIdMultisigIsm({
      validators: config.validators,
      threshold: config.threshold,
    });

    this.logger.debug(`Deployed message id multisig ISM to ${ismAddress}`);
    return ismAddress;
  }

  protected async deployRoutingIsm(
    config: DomainRoutingIsmConfig,
  ): Promise<Address> {
    const routes = [];

    // deploy ISMs for each domain
    for (const chainName of Object.keys(config.domains)) {
      const domainId = this.chainLookup.getDomainId(chainName);
      if (!domainId) {
        this.logger.warn(
          `Unknown chain ${chainName}, skipping ISM configuration`,
        );
        continue;
      }

      const address = await this.deploy({ config: config.domains[chainName] });
      routes.push({
        ismAddress: address,
        domainId: domainId,
      });
    }

    const { ismAddress } = await this.signer.createRoutingIsm({
      routes,
    });

    this.logger.debug(`Deployed routing ISM to ${ismAddress}`);
    return ismAddress;
  }

  protected async updateRoutingIsm({
    actual,
    expected,
    logger,
  }: {
    actual: DomainRoutingIsmConfig;
    expected: DomainRoutingIsmConfig;
    logger: Logger;
  }): Promise<AnnotatedTx[]> {
    this.logger.debug(`Start creating routing ISM update transactions`);

    const updateTxs: AnnotatedTx[] = [];

    const knownChains = new Set(this.chainLookup.getKnownChainNames());

    const { domainsToEnroll, domainsToUnenroll } = calculateDomainRoutingDelta(
      actual,
      expected,
    );

    const knownEnrolls = intersection(knownChains, new Set(domainsToEnroll));

    // Enroll domains
    for (const origin of knownEnrolls) {
      logger.debug(
        `Reconfiguring preexisting routing ISM for origin ${origin}...`,
      );
      const ismAddress = await this.deploy({
        config: expected.domains[origin],
      });

      const { blocks } = this.chainLookup.getChainMetadata(this.chain);

      if (blocks) {
        // we assume at least one confirmation
        const confirmations = blocks.confirmations ?? 1;
        const estimateBlockTime = blocks.estimateBlockTime ?? 0;

        await sleep(confirmations * estimateBlockTime);
      }

      const domainId = this.chainLookup.getDomainId(origin);
      assert(domainId !== null, `Domain ID not found for chain ${origin}`);
      updateTxs.push({
        annotation: `Setting new ISM for origin ${origin}...`,
        ...(await this.signer.getSetRoutingIsmRouteTransaction({
          signer: actual.owner,
          ismAddress: this.args.addresses.deployedIsm,
          route: {
            ismAddress,
            domainId,
          },
        })),
      });
    }

    const knownUnenrolls = intersection(
      knownChains,
      new Set(domainsToUnenroll),
    );

    // Unenroll domains
    for (const origin of knownUnenrolls) {
      const domainId = this.chainLookup.getDomainId(origin);
      assert(domainId !== null, `Domain ID not found for chain ${origin}`);
      updateTxs.push({
        annotation: `Unenrolling originDomain ${domainId} from preexisting routing ISM at ${this.args.addresses.deployedIsm}...`,
        ...(await this.signer.getRemoveRoutingIsmRouteTransaction({
          signer: actual.owner,
          ismAddress: this.args.addresses.deployedIsm,
          domainId,
        })),
      });
    }

    // Update ownership
    if (actual.owner !== expected.owner) {
      updateTxs.push({
        annotation: `Transferring ownership of ISM from ${
          actual.owner
        } to ${expected.owner}`,
        ...(await this.signer.getSetRoutingIsmOwnerTransaction({
          signer: actual.owner,
          ismAddress: this.args.addresses.deployedIsm,
          newOwner: expected.owner,
        })),
      });
    }

    this.logger.debug(
      `Created ${updateTxs.length} update routing ISM transactions.`,
    );

    return updateTxs;
  }

  protected async deployNoopIsm(): Promise<Address> {
    const { ismAddress } = await this.signer.createNoopIsm({});

    this.logger.debug(`Deployed noop ISM to ${ismAddress}`);
    return ismAddress;
  }
}
