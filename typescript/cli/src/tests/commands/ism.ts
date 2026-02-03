import { $, type ProcessPromise } from 'zx';

import { type ChainName, type IsmConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { readYamlOrJsonOrThrow } from '../../utils/files.js';

import { localTestRunCmdPrefix } from './helpers.js';

$.verbose = true;

export class HyperlaneE2EIsmTestCommands {
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

  protected get privateKeyFlag() {
    if (this.protocol === ProtocolType.Ethereum) {
      return '--key';
    }

    return `--key.${this.protocol}`;
  }

  /**
   * Deploys an ISM to the specified chain using the provided config.
   */
  public deploy(
    privateKey: string,
    configPath: string,
    outPath: string,
  ): ProcessPromise {
    return $`${this.cmdPrefix} hyperlane ism deploy \
      --registry ${this.registryPath} \
      --chain ${this.chain} \
      --config ${configPath} \
      --out ${outPath} \
      ${this.privateKeyFlag} ${privateKey} \
      --verbosity debug \
      --yes`;
  }

  /**
   * Reads an ISM config from the specified address.
   */
  public read(address: string, outPath: string): ProcessPromise {
    return $`${this.cmdPrefix} hyperlane ism read \
      --registry ${this.registryPath} \
      --chain ${this.chain} \
      --address ${address} \
      --out ${outPath}`;
  }

  /**
   * Deploys an ISM and returns the deployed address.
   */
  public async deployAndGetAddress(
    privateKey: string,
    configPath: string,
    outPath: string,
  ): Promise<string> {
    await this.deploy(privateKey, configPath, outPath);
    const output = readYamlOrJsonOrThrow<{ address: string }>(outPath);
    return output.address;
  }

  /**
   * Reads the ISM config from the specified address and returns it.
   */
  public async readConfig(
    address: string,
    outPath: string,
  ): Promise<IsmConfig> {
    await this.read(address, outPath);
    return readYamlOrJsonOrThrow<IsmConfig>(outPath);
  }
}
