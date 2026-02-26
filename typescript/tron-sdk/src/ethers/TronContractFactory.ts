import { ContractFactory } from 'ethers';
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
 * TronContractFactory wraps a ContractFactory to handle Tron's deployment flow
 * where contract addresses come from TronWeb rather than being predictable via nonce.
 *
 * This class overrides deploy() to extract the correct contract address from the
 * Tron transaction response, since ethers computes the wrong address using
 * Ethereum's CREATE formula.
 *
 * Usage:
 * ```ts
 * const factory = new TronContractFactory(new Mailbox__factory(), tronWallet);
 * const contract = await factory.deploy(localDomain);
 * ```
 */
export class TronContractFactory<
  F extends ContractFactory,
> extends ContractFactory {
  constructor(
    private readonly factory: F,
    signer?: TronWallet,
  ) {
    super(factory.interface, factory.bytecode, signer);
  }

  /**
   * Deploy a contract and return the connected contract instance.
   *
   * Uses the typed CreateSmartContractTransaction from TronWeb to get
   * the contract address directly from the transaction response.
   */
  override async deploy(
    ...args: Parameters<F['deploy']>
  ): Promise<Awaited<ReturnType<F['deploy']>>> {
    const contract = await super.deploy(...args);
    const { tronTransaction } =
      contract.deployTransaction as TronTransactionResponse;

    assert(
      isDeployTransaction(tronTransaction),
      'Expected CreateSmartContractTransaction for deployment',
    );

    const tronWallet = this.signer as TronWallet;
    const evmAddress = tronWallet.toEvmAddress(
      tronTransaction.contract_address,
    );

    // Re-attach to correct address, preserving deployTransaction
    const deployTransaction = contract.deployTransaction;
    const correctedContract = this.attach(evmAddress);
    (correctedContract as any).deployTransaction = deployTransaction;
    return correctedContract as Awaited<ReturnType<F['deploy']>>;
  }

  /**
   * Returns a new TronContractFactory connected to the given signer.
   */
  override connect(signer: TronWallet): TronContractFactory<F> {
    return new TronContractFactory(this.factory, signer);
  }
}
