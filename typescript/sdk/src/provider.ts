import {
  EventType,
  Filter,
  Listener,
  Provider,
  TransactionRequest,
  TransactionResponse,
} from '@ethersproject/abstract-provider';
import { Debugger, debug } from 'debug';
import { BigNumber, ethers } from 'ethers';
import { isAddress } from 'ethers/lib/utils';
import { Deferrable } from 'ethers/lib/utils';

import { ChainMap, ChainName } from './types';
import { MultiGeneric, objMap } from './utils';

type BlockTag = string | number;
export interface IChainConnection {
  provider: Provider;
  signer?: ethers.Signer;
  overrides?: ethers.Overrides;
  confirmations?: number;
  logger?: Debugger;
}

// TODO: Rename
/**
 * WrappedProvider is an ethers.Provider that can also act like a ethers.Signer
 * if configured. The goal is to allow to create a contract wrapper with this
 * provider once without having to recreate instances when a signer is "reconnected"
 * The abstraction isn't perfect as WrappedProvider has to extend from ethers.signer
 * while it is possible for it to not be configured to be a signer.
 * Consumers of WrappedProvider should be aware of this distinction and use the
 * appropriate methods to assert the desired behavior at runtime.
 */
export class WrappedProvider<
  Chain extends ChainName = ChainName,
> extends ethers.Signer {
  public readonly chain: Chain;
  public readonly provider: Provider;
  public readonly signer?: ethers.Signer;
  public readonly logger: Debugger;
  public readonly overrides: ethers.Overrides;
  public readonly confirmations?: number;
  public readonly _isProvider: boolean;

  constructor(chain: Chain, connection: IChainConnection) {
    super();
    this.chain = chain;
    this.provider = connection.provider;
    this.signer = connection.signer;
    this.logger = connection.logger || debug(`abacus:WrappedProvider:${chain}`);
    this.overrides = connection.overrides || {};
    this.confirmations = connection.confirmations;
    this._isProvider = connection.provider._isProvider;
  }

  perform(method: string, params: any): Promise<any> {
    this.logger('perform', method, params);
    // @ts-ignore
    return this.provider.perform(method, params).then(
      (result: any) => {
        this.logger('DEBUG', method, params, '=>', result);
        return result;
      },
      (error: any) => {
        this.logger('DEBUG:ERROR', method, params, '=>', error);
        throw error;
      },
    );
  }

  isSigner() {
    return !!this.signer;
  }

  getAddress(): Promise<string> {
    if (!this.signer) {
      throw new Error('Not a signer');
    }
    return this.signer.getAddress();
  }

  // TODO: Consider adding invariant checking that the signer didn't change in the source of the operation
  signMessage(message: string | ethers.utils.Bytes): Promise<string> {
    if (!this.signer) {
      throw new Error('Not a signer');
    }
    return this.signer.signMessage(message);
  }
  signTransaction(
    transaction: ethers.utils.Deferrable<TransactionRequest>,
  ): Promise<string> {
    if (!this.signer) {
      throw new Error('Not a signer');
    }
    return this.signer.signTransaction(transaction);
  }
  connect(provider: Provider): ethers.Signer {
    if (!this.signer) {
      throw new Error('Not a signer');
    }
    return this.signer.connect(provider);
  }

  // All provider implementations
  // TODO: Elaborate
  getNetwork() {
    return this.provider.getNetwork();
  }

  getBlockNumber() {
    return this.provider.getBlockNumber();
  }
  getCode(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag> | undefined,
  ) {
    return this.provider.getCode(addressOrName, blockTag);
  }
  getStorageAt(
    addressOrName: string | Promise<string>,
    position: ethers.BigNumberish | Promise<ethers.BigNumberish>,
    blockTag?: BlockTag | Promise<BlockTag> | undefined,
  ) {
    return this.provider.getStorageAt(addressOrName, position, blockTag);
  }
  getBlock(blockHashOrBlockTag: BlockTag | Promise<BlockTag>) {
    return this.provider.getBlock(blockHashOrBlockTag);
  }
  getBlockWithTransactions(blockHashOrBlockTag: BlockTag | Promise<BlockTag>) {
    return this.provider.getBlockWithTransactions(blockHashOrBlockTag);
  }
  getTransaction(transactionHash: string) {
    return this.provider.getTransaction(transactionHash);
  }

  getTransactionReceipt(transactionHash: string) {
    return this.provider.getTransactionReceipt(transactionHash);
  }
  getLogs(filter: Filter) {
    return this.provider.getLogs(filter);
  }
  lookupAddress(address: string | Promise<string>) {
    return this.provider.lookupAddress(address);
  }
  on(eventName: EventType, listener: Listener) {
    return this.provider.on(eventName, listener);
  }
  once(eventName: EventType, listener: Listener) {
    return this.provider.once(eventName, listener);
  }
  emit(eventName: EventType, ...args: any[]) {
    return this.provider.emit(eventName, ...args);
  }
  listenerCount() {
    return this.provider.listenerCount();
  }
  listeners() {
    return this.provider.listeners();
  }
  off(eventName: EventType, listener: Listener) {
    return this.provider.off(eventName, listener);
  }
  removeAllListeners() {
    return this.provider.removeAllListeners();
  }
  addListener(eventName: EventType, listener: Listener) {
    return this.provider.addListener(eventName, listener);
  }
  removeListener(eventName: EventType, listener: Listener) {
    return this.provider.removeListener(eventName, listener);
  }
  waitForTransaction(
    transactionHash: string,
    confirmations?: number | undefined,
    timeout?: number | undefined,
  ) {
    return this.provider.waitForTransaction(
      transactionHash,
      confirmations,
      timeout,
    );
  }

  async getBalance(blockTag?: BlockTag | undefined): Promise<BigNumber>;
  async getBalance(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag> | undefined,
  ): Promise<BigNumber>;
  async getBalance(
    addressOrNameOrBlockTag: BlockTag | string | Promise<string> | undefined,
    blockTag?: BlockTag | Promise<BlockTag> | undefined,
  ) {
    // TODO: Extract and solidify
    if (
      addressOrNameOrBlockTag !== undefined &&
      typeof blockTag !== 'number' &&
      // Compiler is unable to to understand that addressOrNameOrBlockTag can't be a number
      // @ts-ignore
      isAddress(addressOrNameOrBlockTag)
    ) {
      // @ts-ignore
      return this.provider.getBalance(addressOrNameOrBlockTag, blockTag);
    } else {
      return this.provider.getBalance(
        this.getAddress(),
        addressOrNameOrBlockTag,
      );
    }
  }

  async getTransactionCount(blockTag?: BlockTag | undefined): Promise<number>;
  async getTransactionCount(
    addressOrName: string | Promise<string>,
    blockTag?: BlockTag | Promise<BlockTag> | undefined,
  ): Promise<number>;
  async getTransactionCount(
    addressOrNameOrBlockTag: BlockTag | string | Promise<string> | undefined,
    blockTag?: BlockTag | Promise<BlockTag> | undefined,
  ) {
    if (
      addressOrNameOrBlockTag !== undefined &&
      typeof blockTag !== 'number' &&
      // Compiler is unable to to understand that addressOrNameOrBlockTag can't be a number
      // @ts-ignore
      isAddress(addressOrNameOrBlockTag)
    ) {
      return this.provider.getTransactionCount(
        // @ts-ignore
        addressOrNameOrBlockTag,
        blockTag,
      );
    } else {
      return this.provider.getTransactionCount(
        this.getAddress(),
        addressOrNameOrBlockTag,
      );
    }
  }

  async sendTransaction(
    transaction: Deferrable<TransactionRequest>,
  ): Promise<TransactionResponse>;
  async sendTransaction(
    signedTransaction: string | Promise<string>,
  ): Promise<TransactionResponse>;
  async sendTransaction(
    rawOrSignedTransactionPromise:
      | Deferrable<TransactionRequest>
      | string
      | Promise<string>,
  ) {
    return Promise.resolve(rawOrSignedTransactionPromise).then(
      (rawOrSignedTransaction) => {
        // We are assuming here that a transaction request is an object vs. a string
        if (typeof rawOrSignedTransaction === 'object') {
          // We attempt to sign a transaction
          if (!this.signer) {
            throw new Error('Not a signer');
          }
          return this.signer.sendTransaction(rawOrSignedTransaction);
        } else {
          return this.provider.sendTransaction(rawOrSignedTransaction);
        }
      },
    );
  }
}

/**
 * MultiProvider is a critical abstraction for the Abacus' SDK with a goal
 * of managing providers and signers for all configured chains without the
 * need to recreate contract wrappers. As per the notes for WrappedProvider,
 * developers should be aware that the "providers" returned can be ethers.Signer
 * or not and use the appropriate function to assert this at runtime (i.e. use
 * getProvider vs getSigner)
 */
export class MultiProvider<
  Chain extends ChainName = ChainName,
> extends MultiGeneric<Chain, WrappedProvider> {
  constructor(chainConnectionConfigs: ChainMap<Chain, IChainConnection>) {
    super(
      objMap(
        chainConnectionConfigs,
        (chain, connection) => new WrappedProvider(chain, connection),
      ),
    );
  }

  /**
   * Returns the provider for a given chain
   * @param chain The name of the chain for which to get the provider
   */
  getProvider(chain: Chain) {
    return this.get(chain);
  }

  /**
   * Same as `getProvider` however asserts that the provider is actually a signer
   * as well
   * @param chain The name of the chain for which to get the signer
   */
  getSigner(chain: Chain) {
    const signer = this.get(chain);
    if (!signer.isSigner()) {
      throw new Error(`Provider for chain ${chain} does not have a signer`);
    }
    return signer;
  }

  /**
   * Returns whether there exists a provider for a given chain
   * @param chain The name of the chain for which to get the provider
   */
  hasChainProvider(chain: Chain) {
    return !!this.get(chain);
  }

  /**
   * Returns whether there exists a signer for a given chain
   * @param chain The name of the chain for which to get the signer
   */
  hasChainSigner(chain: Chain) {
    const signer = this.get(chain);
    return !!signer && signer.isSigner();
  }
}
