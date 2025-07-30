import { $, ProcessPromise } from 'zx';

import { ChainAddresses } from '@hyperlane-xyz/registry';
import { ChainName, DerivedCoreConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { getContext } from '../../context/context.js';
import { readYamlOrJson } from '../../utils/files.js';

import { localTestRunCmdPrefix } from './helpers.js';

export class HyperlaneE2ECoreTestCommands {
  protected cmdPrefix: string[];

  protected protocol: ProtocolType;
  protected chain: ChainName;
  protected registryPath: string;

  protected coreInputPath: string;
  protected coreOutputPath: string;

  constructor(
    protocol: ProtocolType,
    chain: ChainName,
    registryPath: string,
    coreInputPath: string,
    coreOutputPath: string,
  ) {
    this.cmdPrefix = localTestRunCmdPrefix();

    this.protocol = protocol;
    this.chain = chain;
    this.registryPath = registryPath;

    this.coreInputPath = coreInputPath;
    this.coreOutputPath = coreOutputPath;
  }

  protected get privateKeyFlag() {
    if (this.protocol === ProtocolType.Ethereum) {
      return '--key';
    }

    return `--key.${this.protocol}`;
  }

  protected get hypKeyEnvName() {
    if (this.protocol === ProtocolType.Ethereum) {
      return 'HYP_KEY';
    }

    return `HYP_KEY_${this.protocol.toUpperCase()}`;
  }

  public setCoreInputPath(coreInputPath: string) {
    this.coreInputPath = coreInputPath;
  }

  public setCoreOutputPath(coreOutputPath: string) {
    this.coreOutputPath = coreOutputPath;
  }

  /**
   * Creates a Hyperlane core deployment config
   */
  public init(privateKey?: string, privateKeyEnv?: string): ProcessPromise {
    const flags = [
      '--registry',
      this.registryPath,
      '--config',
      this.coreOutputPath,
      '--verbosity',
      'debug',
      '--yes',
    ];

    if (privateKey) {
      flags.push(this.privateKeyFlag, privateKey);
    }

    return $`${
      privateKeyEnv ? [`${this.hypKeyEnvName}=${privateKeyEnv}`] : []
    } ${this.cmdPrefix} hyperlane core init ${flags}`;
  }

  /**
   * Reads a Hyperlane core deployment on the specified chain using the provided config.
   */
  public read(): ProcessPromise {
    return $`${this.cmdPrefix} hyperlane core read \
        --registry ${this.registryPath} \
        --config ${this.coreOutputPath} \
        --chain ${this.chain} \
        --verbosity debug \
        --yes`;
  }

  /**
   * Reads the Core deployment config and outputs it to specified output path.
   */
  public async readConfig(): Promise<DerivedCoreConfig> {
    await this.read();
    return readYamlOrJson(this.coreOutputPath);
  }

  /**
   * Verifies that a Hyperlane core deployment matches the provided config on the specified chain.
   */
  public check(mailbox?: string): ProcessPromise {
    const flags = [
      '--registry',
      this.registryPath,
      '--config',
      this.coreOutputPath,
      '--chain',
      this.chain,
      '--verbosity',
      'debug',
      '--yes',
    ];

    if (mailbox) {
      flags.push('--mailbox', mailbox);
    }

    return $`${this.cmdPrefix} hyperlane core check ${flags}`;
  }

  /**
   * Deploys the Hyperlane core contracts to the specified chain using the provided config.
   */
  public deployRaw(
    privateKey?: string,
    privateKeyEnv?: string,
    skipConfirmationPrompts?: boolean,
  ): ProcessPromise {
    const flags = [
      '--registry',
      this.registryPath,
      '--config',
      this.coreInputPath,
      '--verbosity',
      'debug',
    ];

    if (privateKey) {
      flags.push(this.privateKeyFlag, privateKey);
    }

    if (skipConfirmationPrompts) {
      flags.push('--yes');
    }

    return $`${
      privateKeyEnv ? [`${this.hypKeyEnvName}=${privateKeyEnv}`] : []
    } ${this.cmdPrefix} hyperlane core deploy ${flags}`;
  }

  /**
   * Deploys the Hyperlane core contracts to the specified chain using the provided config.
   */
  public deploy(privateKey: string): ProcessPromise {
    return $`${this.cmdPrefix} hyperlane core deploy \
        --registry ${this.registryPath} \
        --config ${this.coreInputPath} \
        --chain ${this.chain} \
        ${this.privateKeyFlag} ${privateKey} \
        --verbosity debug \
        --yes`;
  }

  /**
   * Deploys new core contracts on the specified chain if it doesn't already exist, and returns the chain addresses.
   */
  public async deployOrUseExistingCore(
    privateKey: string,
  ): Promise<ChainAddresses> {
    const { registry } = await getContext({
      registryUris: [this.registryPath],
      key: privateKey,
    });
    const addresses = (await registry.getChainAddresses(
      this.chain,
    )) as ChainAddresses;

    if (!addresses) {
      await this.deploy(privateKey);
      return this.deployOrUseExistingCore(privateKey);
    }

    return addresses;
  }

  /**
   * Updates a Hyperlane core deployment on the specified chain using the provided config.
   */
  public apply(privateKey: string): ProcessPromise {
    return $`${this.cmdPrefix} hyperlane core apply \
        --registry ${this.registryPath} \
        --config ${this.coreOutputPath} \
        --chain ${this.chain} \
        ${this.privateKeyFlag} ${privateKey} \
        --verbosity debug \
        --yes`;
  }
}
