import { $, ProcessPromise } from 'zx';

import { DerivedCoreConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';

import { localTestRunCmdPrefix } from './helpers.js';

export class HyperlaneCore {
  protected cmdPrefix: string[];

  protected protocol: ProtocolType;
  protected registryPath: string;

  protected coreInputPath: string;
  protected coreOutputPath: string;

  constructor(
    protocol: ProtocolType,
    registryPath: string,
    coreInputPath: string,
    coreOutputPath: string,
  ) {
    this.cmdPrefix = localTestRunCmdPrefix();

    this.protocol = protocol;
    this.registryPath = registryPath;

    this.coreInputPath = coreInputPath;
    this.coreOutputPath = coreOutputPath;
  }

  protected get privateKeyFlag() {
    return `--key.${this.protocol}`;
  }

  protected get hypKeyEnvName() {
    return `HYP_KEY_${this.protocol.toUpperCase()}`;
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

    return $`${[
      `${this.hypKeyEnvName}=${privateKeyEnv}`,
    ]} ${this.cmdPrefix} hyperlane core init ${flags}`;
  }

  /**
   * Reads a Hyperlane core deployment on the specified chain using the provided config.
   */
  public read(chain: string): ProcessPromise {
    return $`${this.cmdPrefix} hyperlane core read \
        --registry ${this.registryPath} \
        --config ${this.coreOutputPath} \
        --chain ${chain} \
        --verbosity debug \
        --yes`;
  }

  /**
   * Reads the Core deployment config and outputs it to specified output path.
   */
  public async readConfig(chain: string): Promise<DerivedCoreConfig> {
    await this.read(chain);
    return readYamlOrJson(this.coreOutputPath);
  }

  /**
   * Verifies that a Hyperlane core deployment matches the provided config on the specified chain.
   */
  public check(chain: string, mailbox?: string): ProcessPromise {
    const flags = [
      '--registry',
      this.registryPath,
      '--config',
      this.coreOutputPath,
      '--chain',
      chain,
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

    return $`${[
      `${this.hypKeyEnvName}=${privateKeyEnv}`,
    ]} ${this.cmdPrefix} hyperlane core deploy ${flags}`;
  }

  /**
   * Deploys the Hyperlane core contracts to the specified chain using the provided config.
   */
  public deploy(chain: string, privateKey: string): ProcessPromise {
    return $`${this.cmdPrefix} hyperlane core deploy \
        --registry ${this.registryPath} \
        --config ${this.coreInputPath} \
        --chain ${chain} \
        ${this.privateKeyFlag} ${privateKey} \
        --verbosity debug \
        --yes`;
  }

  /**
   * Updates a Hyperlane core deployment on the specified chain using the provided config.
   */
  public apply(chain: string, privateKey: string): ProcessPromise {
    return $`${this.cmdPrefix} hyperlane core apply \
        --registry ${this.registryPath} \
        --config ${this.coreOutputPath} \
        --chain ${chain} \
        ${this.privateKeyFlag} ${privateKey} \
        --verbosity debug \
        --yes`;
  }
}
