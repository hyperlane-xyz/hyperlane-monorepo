import { Contract, ContractFactory, Signer } from 'ethers';
import { Types } from 'tronweb';

import { assert } from '@hyperlane-xyz/utils';

import { TronTransactionResponse, TronWallet } from './TronWallet.js';

/**
 * Type guard for CreateSmartContractTransaction
 */
function isDeployTransaction(
  tx: TronTransactionResponse['tronTransaction'],
): tx is Types.CreateSmartContractTransaction {
  return 'contract_address' in tx;
}

/**
 * TronContractFactory wraps a standard ethers ContractFactory to handle
 * Tron's deployment flow where contract addresses come from TronWeb
 * rather than being predictable via nonce.
 *
 * Usage:
 * ```ts
 * const factory = new TronContractFactory(Mailbox__factory, tronWallet);
 * const contract = await factory.deploy(localDomain);
 * ```
 */
export class TronContractFactory<
  F extends ContractFactory = ContractFactory,
  C extends Contract = Contract,
> {
  private readonly factory: F;

  constructor(
    factoryClass: new (signer: Signer) => F,
    private readonly signer: TronWallet,
  ) {
    this.factory = new factoryClass(signer);
  }

  /**
   * Deploy a contract and return the connected contract instance.
   *
   * Uses the typed CreateSmartContractTransaction from TronWeb to get
   * the contract address directly from the transaction response.
   */
  async deploy(...args: Parameters<F['deploy']>): Promise<C> {
    const contract = await this.factory.deploy(...args);
    const { tronTransaction } =
      contract.deployTransaction as TronTransactionResponse;

    assert(
      isDeployTransaction(tronTransaction),
      'Expected CreateSmartContractTransaction for deployment',
    );

    const evmAddress = this.signer.toEvmAddress(
      tronTransaction.contract_address,
    );
    return this.factory.attach(evmAddress) as C;
  }

  /**
   * Attach to an existing contract at the given address.
   */
  attach(address: string): C {
    return this.factory.attach(address) as C;
  }

  /**
   * Get the underlying factory instance.
   */
  getFactory(): F {
    return this.factory;
  }

  /**
   * Get the signer used by this factory.
   */
  getSigner(): TronWallet {
    return this.signer;
  }
}

/**
 * Helper to create a TronContractFactory from a factory class.
 */
export function createTronFactory<
  F extends ContractFactory,
  C extends Contract = Contract,
>(
  factoryClass: new (signer: Signer) => F,
  signer: TronWallet,
): TronContractFactory<F, C> {
  return new TronContractFactory<F, C>(factoryClass, signer);
}
