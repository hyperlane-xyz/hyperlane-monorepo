/**
 * Temporary stub types for HypPrivate contracts
 * These will be replaced by actual generated types once Solidity contracts are compiled
 */

import { PopulatedTransaction } from 'ethers';
import { Contract, Signer } from 'ethers';
import { Provider } from '@ethersproject/providers';

// Stub interface for HypPrivate base contract
export interface HypPrivate extends Contract {
  domains(): Promise<number[]>;
  routers(domain: number): Promise<string>;
  aleoPrivacyHub(): Promise<string>;
  aleoDomain(): Promise<number>;
  commitmentNonce(): Promise<{ toNumber(): number }>;
  isCommitmentUsed(commitment: string): Promise<boolean>;
  getRemoteRouter(domain: number): Promise<string>;
  quoteGasPayment(domain: number): Promise<any>;
  populateTransaction: {
    enrollRemoteRouter(
      domain: number,
      router: string,
    ): Promise<PopulatedTransaction>;
  };
}

// Stub interface for HypPrivateNative contract
export interface HypPrivateNative extends HypPrivate {
  populateTransaction: HypPrivate['populateTransaction'] & {
    depositPrivate(
      secret: string,
      finalDestination: number,
      recipient: string,
      overrides?: { value?: any },
    ): Promise<PopulatedTransaction>;
  };
}

// Stub interface for HypPrivateCollateral contract
export interface HypPrivateCollateral extends HypPrivate {
  token(): Promise<string>;
  collateralBalance(): Promise<any>;
  populateTransaction: HypPrivate['populateTransaction'] & {
    depositPrivate(
      secret: string,
      finalDestination: number,
      recipient: string,
      overrides?: { value?: any },
    ): Promise<PopulatedTransaction>;
    transferRemoteCollateral(
      destination: number,
      amount: any,
      overrides?: { value?: any },
    ): Promise<PopulatedTransaction>;
  };
}

// Stub interface for HypPrivateSynthetic contract
export interface HypPrivateSynthetic extends HypPrivate {
  populateTransaction: HypPrivate['populateTransaction'] & {
    depositPrivate(
      secret: string,
      finalDestination: number,
      recipient: string,
      overrides?: { value?: any },
    ): Promise<PopulatedTransaction>;
  };
}

// Stub factory classes
export class HypPrivateNative__factory {
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): HypPrivateNative {
    // This is a stub - will be replaced by actual factory
    throw new Error(
      'HypPrivateNative__factory stub - compile Solidity contracts first',
    );
  }
}

export class HypPrivateCollateral__factory {
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): HypPrivateCollateral {
    throw new Error(
      'HypPrivateCollateral__factory stub - compile Solidity contracts first',
    );
  }
}

export class HypPrivateSynthetic__factory {
  static connect(
    address: string,
    signerOrProvider: Signer | Provider,
  ): HypPrivateSynthetic {
    throw new Error(
      'HypPrivateSynthetic__factory stub - compile Solidity contracts first',
    );
  }
}
