import { ContractFactory, ContractRunner } from 'ethers';
import { Types } from 'tronweb';

import { assert } from '@hyperlane-xyz/utils';

import { TronWallet } from './TronWallet.js';

/**
 * Type guard for CreateSmartContractTransaction
 */
function isDeployTransaction(
  tx: Types.Transaction | Types.CreateSmartContractTransaction | undefined,
): tx is Types.CreateSmartContractTransaction {
  return !!tx && 'contract_address' in tx;
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
    super(
      factory.interface,
      factory.bytecode,
      signer as ContractRunner | undefined,
    );
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
    const deploymentTx = contract.deploymentTransaction();
    if (!deploymentTx) {
      throw new Error('Expected deployment transaction for deployed contract');
    }

    const runner = this.runner as TronWallet | null;
    if (!runner) {
      throw new Error('TronContractFactory runner is required');
    }

    const tronTransaction = runner.getTronTransaction(deploymentTx.hash);

    assert(
      isDeployTransaction(tronTransaction),
      'Expected CreateSmartContractTransaction for deployment',
    );

    const evmAddress = runner.toEvmAddress(tronTransaction.contract_address);

    // Re-attach to Tron-derived address, preserving deploymentTransaction.
    const correctedContract = this.attach(evmAddress);
    (correctedContract as any).deploymentTransaction = () => deploymentTx;
    return correctedContract as Awaited<ReturnType<F['deploy']>>;
  }

  /**
   * Returns a new TronContractFactory connected to the given signer.
   */
  override connect(runner: ContractRunner | null): TronContractFactory<F> {
    return new TronContractFactory(
      this.factory,
      (runner as TronWallet | null) ?? undefined,
    );
  }
}
