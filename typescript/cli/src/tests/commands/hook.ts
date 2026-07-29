import { $, type ProcessPromise } from 'zx';

import { type ChainName, type DerivedHookConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';

import { localTestRunCmdPrefix } from './helpers.js';

$.verbose = true;

export class HyperlaneE2EHookTestCommands {
  protected cmdPrefix: string[];

  protected protocol: ProtocolType;
  protected chain: ChainName;
  protected registryPath: string;

  constructor(protocol: ProtocolType, chain: ChainName, registryPath: string) {
    this.cmdPrefix = localTestRunCmdPrefix();

    this.protocol = protocol;
    this.chain = chain;
    this.registryPath = registryPath;
  }

  protected get privateKeyFlag(): string {
    if (this.protocol === ProtocolType.Ethereum) {
      return '--key';
    }

    return `--key.${this.protocol}`;
  }

  /**
   * Deploys a hook to the chain using the provided config, writing the
   * deployed address to `outPath`.
   */
  public deploy(
    privateKey: string,
    configPath: string,
    outPath: string,
  ): ProcessPromise {
    return $`${this.cmdPrefix} hyperlane hook deploy \
      --registry ${this.registryPath} \
      --chain ${this.chain} \
      --config ${configPath} \
      --out ${outPath} \
      ${this.privateKeyFlag} ${privateKey} \
      --verbosity debug \
      --yes`;
  }

  /**
   * Reads a hook config from the specified address into `outPath`.
   */
  public read(address: string, outPath: string): ProcessPromise {
    return $`${this.cmdPrefix} hyperlane hook read \
      --registry ${this.registryPath} \
      --chain ${this.chain} \
      --address ${address} \
      --out ${outPath} \
      --verbosity debug`;
  }

  /**
   * Applies a hook config to an existing on-chain hook at `address`.
   */
  public apply(
    privateKey: string,
    address: string,
    configPath: string,
  ): ProcessPromise {
    return $`${this.cmdPrefix} hyperlane hook apply \
      --registry ${this.registryPath} \
      --chain ${this.chain} \
      --address ${address} \
      --config ${configPath} \
      ${this.privateKeyFlag} ${privateKey} \
      --verbosity debug \
      --yes`;
  }

  /**
   * Deploys a hook and returns the deployed address.
   */
  public async deployAndGetAddress(
    privateKey: string,
    configPath: string,
    outPath: string,
  ): Promise<string> {
    await this.deploy(privateKey, configPath, outPath);
    const output = readYamlOrJson<{ address: string }>(outPath);
    return output.address;
  }

  /**
   * Reads the hook config at `address` and returns it parsed.
   */
  public async readConfig(
    address: string,
    outPath: string,
  ): Promise<DerivedHookConfig> {
    await this.read(address, outPath);
    return readYamlOrJson(outPath);
  }
}
