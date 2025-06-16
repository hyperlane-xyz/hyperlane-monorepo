import { Logger } from 'pino';
import { Account as StarknetAccount } from 'starknet';

import {
  Address,
  ChainId,
  Domain,
  ProtocolType,
  assert,
  deepEquals,
  intersection,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { transferOwnershipTransactionsStarknet } from '../contracts/contracts.js';
import {
  HyperlaneModule,
  HyperlaneModuleParams,
} from '../core/AbstractHyperlaneModule.js';
import { StarknetDeployer } from '../deploy/StarknetDeployer.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { AnnotatedStarknetTransaction } from '../providers/ProviderType.js';
import { ChainName } from '../types.js';
import { normalizeConfig } from '../utils/ism.js';
import { getStarknetContract } from '../utils/starknet.js';

import { StarknetIsmReader } from './StarknetIsmReader.js';
import { StarknetIsmContractName } from './starknet-utils.js';
import {
  DomainRoutingIsmConfig,
  IsmConfig,
  IsmConfigSchema,
  IsmType,
  MUTABLE_ISM_TYPE,
} from './types.js';
import { calculateDomainRoutingDelta } from './utils.js';

type IsmModuleAddresses = {
  deployedIsm: Address;
  mailbox: Address;
};

export class StarknetIsmModule extends HyperlaneModule<
  ProtocolType.Starknet,
  IsmConfig,
  IsmModuleAddresses
> {
  protected readonly logger: Logger;
  protected readonly deployer: StarknetDeployer;
  protected readonly reader: StarknetIsmReader;
  protected readonly multiProtocolProvider: MultiProtocolProvider;
  protected readonly signer: StarknetAccount;

  public readonly chain: ChainName;
  public readonly chainId: ChainId;
  public readonly domainId: Domain;

  constructor(
    multiProtocolProvider: MultiProtocolProvider,
    params: HyperlaneModuleParams<IsmConfig, IsmModuleAddresses>,
    signer: StarknetAccount,
  ) {
    super(params);

    this.logger = rootLogger.child({ module: 'StarknetIsmModule' });
    this.multiProtocolProvider = multiProtocolProvider;
    this.signer = signer;
    const multiProvider = this.multiProtocolProvider.toMultiProvider();
    this.chain = multiProvider.getChainName(this.args.chain);
    this.chainId = multiProvider.getChainId(this.args.chain);
    this.domainId = multiProvider.getDomainId(this.args.chain);

    this.deployer = new StarknetDeployer(this.signer, multiProvider);
    this.reader = new StarknetIsmReader(this.multiProtocolProvider, this.chain);
  }

  public async read(): Promise<IsmConfig> {
    return typeof this.args.config === 'string'
      ? this.args.addresses.deployedIsm
      : this.reader.deriveIsmConfig(this.args.addresses.deployedIsm);
  }

  public async update(
    targetConfig: IsmConfig,
  ): Promise<AnnotatedStarknetTransaction[]> {
    targetConfig = IsmConfigSchema.parse(targetConfig);

    // Do not support updating to a custom ISM address
    if (typeof targetConfig === 'string') {
      throw new Error(
        'Invalid targetConfig: Updating to a custom ISM address is not supported. Please provide a valid ISM configuration.',
      );
    }

    // save current config for comparison
    // normalize the config to ensure it's in a consistent format for comparison
    const currentConfig = normalizeConfig(await this.read());
    // Update the config
    this.args.config = targetConfig;
    targetConfig = normalizeConfig(targetConfig);

    assert(
      typeof targetConfig === 'object',
      'normalized targetConfig should be an object',
    );

    // If configs match, no updates needed
    if (deepEquals(currentConfig, targetConfig)) {
      return [];
    }

    // Else, we have to figure out what an update for this ISM entails
    // Check if we need to deploy a new ISM
    if (
      // if updating from an address/custom config to a proper ISM config, do a new deploy
      typeof currentConfig === 'string' ||
      // if updating a proper ISM config whose types are different, do a new deploy
      currentConfig.type !== targetConfig.type ||
      // if it is not a mutable ISM, do a new deploy
      !MUTABLE_ISM_TYPE.includes(targetConfig.type)
    ) {
      this.args.addresses.deployedIsm = await this.deployer.deployIsm({
        chain: this.multiProtocolProvider.getChainName(this.chain),
        ismConfig: targetConfig,
        mailbox: this.args.addresses.mailbox,
      });

      return [];
    }

    // At this point, only the 3 ownable/mutable ISM types should remain: PAUSABLE, ROUTING, FALLBACK_ROUTING
    if (
      targetConfig.type !== IsmType.PAUSABLE &&
      targetConfig.type !== IsmType.ROUTING &&
      targetConfig.type !== IsmType.FALLBACK_ROUTING
    ) {
      throw new Error(`Unsupported ISM type ${targetConfig.type}`);
    }

    const logger = this.logger.child({
      destination: this.chain,
      ismType: targetConfig.type,
    });
    logger.debug(`Updating ${targetConfig.type} on ${this.chain}`);

    let updateTxs: AnnotatedStarknetTransaction[] = [];
    if (
      targetConfig.type === IsmType.ROUTING ||
      targetConfig.type === IsmType.FALLBACK_ROUTING
    ) {
      updateTxs = await this.updateRoutingIsm({
        current: currentConfig,
        target: targetConfig,
        logger,
      });
    }

    // Lastly, check if the resolved owner is different from the current owner
    updateTxs.push(
      ...transferOwnershipTransactionsStarknet(
        this.args.addresses.deployedIsm,
        currentConfig,
        targetConfig,
      ),
    );

    return updateTxs;
  }

  protected async updateRoutingIsm({
    current,
    target,
    logger,
  }: {
    current: DomainRoutingIsmConfig;
    target: DomainRoutingIsmConfig;
    logger: Logger;
  }): Promise<AnnotatedStarknetTransaction[]> {
    const contract = getStarknetContract(
      StarknetIsmContractName[IsmType.ROUTING],
      this.args.addresses.deployedIsm,
      this.signer,
    );

    const updateTxs: AnnotatedStarknetTransaction[] = [];

    const knownChains = new Set(
      this.multiProtocolProvider.getKnownChainNames(),
    );

    const { domainsToEnroll, domainsToUnenroll } = calculateDomainRoutingDelta(
      current,
      target,
    );

    const knownEnrolls = intersection(knownChains, new Set(domainsToEnroll));

    // Enroll domains
    for (const origin of knownEnrolls) {
      logger.debug(
        `Reconfiguring preexisting routing ISM for origin ${origin}...`,
      );
      const ism = await this.deploy({
        config: target.domains[origin],
      });

      const domainId = this.multiProtocolProvider.getDomainId(origin);
      const tx = await contract.populateTransaction.set(domainId, ism);
      updateTxs.push({
        chainId: this.chainId,
        annotation: `Setting new ISM for origin ${origin}...`,
        ...tx,
      });
    }

    const knownUnenrolls = intersection(
      knownChains,
      new Set(domainsToUnenroll),
    );

    // Unenroll domains
    for (const origin of knownUnenrolls) {
      const domainId = this.multiProtocolProvider.getDomainId(origin);
      const tx = await contract.populateTransaction.remove(domainId);
      updateTxs.push({
        chainId: this.chainId,
        annotation: `Unenrolling originDomain ${domainId} from preexisting routing ISM at ${this.args.addresses.deployedIsm}...`,
        ...tx,
      });
    }

    return updateTxs;
  }

  protected async deploy({ config }: { config: IsmConfig }): Promise<Address> {
    config = IsmConfigSchema.parse(config);

    return this.deployer.deployIsm({
      chain: this.chain,
      ismConfig: config,
      mailbox: this.args.addresses.mailbox,
    });
  }
}
