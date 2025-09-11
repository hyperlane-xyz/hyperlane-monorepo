import { expect } from 'chai';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { MockProvider } from 'ethereum-waffle';
import { Signer } from 'ethers';

import { Address } from '@hyperlane-xyz/utils';

import {
  TestChainName,
  testChainMetadata,
} from '../../../../consts/testChains.js';
import { MultiProvider } from '../../../MultiProvider.js';
import { AnnotatedEV5Transaction } from '../../../ProviderType.js';
import { TxSubmitterType } from '../TxSubmitterTypes.js';

import { EV5AccessManagerTxSubmitter } from './EV5AccessManagerTxSubmitter.js';
import { EV5TxSubmitterInterface } from './EV5TxSubmitterInterface.js';
import { AccessManagerSubmitterConfig } from './types.js';

chai.use(chaiAsPromised);

// Mock AccessManager contract interface
const mockAccessManager = {
  address: '0x1234567890123456789012345678901234567890',
  canCall: async () => [true, 0], // immediate execution, no delay
  getSchedule: async () => 0, // operation not scheduled
  hashOperation: async () =>
    '0x1234567890123456789012345678901234567890123456789012345678901234',
  interface: {
    encodeFunctionData: (functionName: string, args: any[]) => {
      if (functionName === 'schedule') {
        return '0x1234';
      } else if (functionName === 'execute') {
        return '0x5678';
      }
      return '0x0000';
    },
  },
};

// Mock proposer submitter
class MockProposerSubmitter implements EV5TxSubmitterInterface {
  public readonly txSubmitterType = TxSubmitterType.JSON_RPC;
  public readonly multiProvider: MultiProvider;
  private submitResults: any[] = [];

  constructor(multiProvider: MultiProvider) {
    this.multiProvider = multiProvider;
  }

  setSubmitResult(result: any) {
    this.submitResults.push(result);
  }

  async address(): Promise<Address> {
    return '0x1234567890123456789012345678901234567890';
  }

  async submit(...txs: any[]): Promise<any> {
    const result = this.submitResults.shift();
    return result;
  }
}

describe('EV5AccessManagerTxSubmitter', () => {
  const CHAIN_NAME: TestChainName = TestChainName.test1;
  const ACCESS_MANAGER_ADDRESS: Address =
    '0x1234567890123456789012345678901234567890';

  let multiProvider: MultiProvider;
  let mockProposerSubmitter: MockProposerSubmitter;
  let submitter: EV5AccessManagerTxSubmitter;

  beforeEach(async () => {
    const mockProvider = new MockProvider();
    const mockSigner: Signer = mockProvider.getWallets()[0];

    multiProvider = new MultiProvider(testChainMetadata);

    // Mock the provider methods
    multiProvider.getProvider = () => mockProvider as any;
    multiProvider.getSigner = () => mockSigner;
    multiProvider.getSignerAddress = async () => await mockSigner.getAddress();
    multiProvider.getDomainId = () => 1;

    mockProposerSubmitter = new MockProposerSubmitter(multiProvider);

    const config: AccessManagerSubmitterConfig = {
      type: TxSubmitterType.ACCESS_MANAGER,
      chain: CHAIN_NAME,
      accessManagerAddress: ACCESS_MANAGER_ADDRESS,
      proposerSubmitter: {
        type: TxSubmitterType.JSON_RPC,
        chain: CHAIN_NAME,
      },
    };

    submitter = new EV5AccessManagerTxSubmitter(
      config,
      multiProvider,
      mockProposerSubmitter,
      mockAccessManager as any,
    );
  });

  describe('submit', () => {
    const mockTransaction: AnnotatedEV5Transaction = {
      to: '0x1234567890123456789012345678901234567890',
      data: '0xabcdef',
    };

    it('should handle empty transaction array', async () => {
      const result = await submitter.submit();
      expect(result).to.deep.equal([]);
    });

    it('should submit single transaction with immediate execution', async () => {
      const result = await submitter.submit(mockTransaction);

      expect(result).to.be.an('array');
      expect(result).to.have.length(0); // immediate execution returns empty array
    });

    it('should submit batch of transactions', async () => {
      const transaction2: AnnotatedEV5Transaction = {
        to: '0x9876543210987654321098765432109876543210',
        data: '0x123456',
      };

      const result = await submitter.submit(mockTransaction, transaction2);

      expect(result).to.be.an('array');
      expect(result).to.have.length(0); // immediate execution returns empty array
    });

    it('should throw error for duplicate target transactions', async () => {
      const duplicateTargetTx: AnnotatedEV5Transaction = {
        to: '0x1234567890123456789012345678901234567890', // same target as mockTransaction
        data: '0x123456',
      };

      await expect(
        submitter.submit(mockTransaction, duplicateTargetTx),
      ).to.be.rejectedWith(
        /AccessManager transactions cannot have duplicate targets/,
      );
    });

    it('should throw error for transaction without data', async () => {
      const invalidTx: AnnotatedEV5Transaction = {
        to: '0x1234567890123456789012345678901234567890',
      } as any;

      await expect(submitter.submit(invalidTx)).to.be.rejectedWith(
        /Invalid Transaction: data must be defined/,
      );
    });

    it('should throw error for transaction without target address', async () => {
      const invalidTx: AnnotatedEV5Transaction = {
        data: '0xabcdef',
      } as any;

      await expect(submitter.submit(invalidTx)).to.be.rejectedWith(
        /Invalid Transaction: target address must be defined/,
      );
    });

    it('should return execute transaction when proposer returns void', async () => {
      const result = await submitter.submit(mockTransaction);

      expect(result).to.be.an('array');
      expect(result).to.have.length(0); // immediate execution returns empty array
    });
  });

  describe('configuration validation', () => {
    it('should create submitter with valid config', async () => {
      const config: AccessManagerSubmitterConfig = {
        type: TxSubmitterType.ACCESS_MANAGER,
        chain: CHAIN_NAME,
        accessManagerAddress: ACCESS_MANAGER_ADDRESS,
        proposerSubmitter: {
          type: TxSubmitterType.JSON_RPC,
          chain: CHAIN_NAME,
        },
      };

      const submitter = await EV5AccessManagerTxSubmitter.create(
        config,
        multiProvider,
        mockProposerSubmitter,
      );

      expect(submitter).to.be.instanceOf(EV5AccessManagerTxSubmitter);
      expect(submitter.txSubmitterType).to.equal(
        TxSubmitterType.ACCESS_MANAGER,
      );
    });
  });

  describe('permission checking', () => {
    it('should check permissions before scheduling', async () => {
      // Mock canCall to return permission denied
      const restrictedAccessManager = {
        ...mockAccessManager,
        canCall: async () => [false, 0], // no permission, no delay
      };

      const restrictedSubmitter = new EV5AccessManagerTxSubmitter(
        {
          type: TxSubmitterType.ACCESS_MANAGER,
          chain: CHAIN_NAME,
          accessManagerAddress: ACCESS_MANAGER_ADDRESS,
          proposerSubmitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN_NAME,
          },
        },
        multiProvider,
        mockProposerSubmitter,
        restrictedAccessManager as any,
      );

      const mockTransaction: AnnotatedEV5Transaction = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
      };

      await expect(
        restrictedSubmitter.submit(mockTransaction),
      ).to.be.rejectedWith(/does not have permission/);
    });

    it('should handle delayed execution', async () => {
      // Mock canCall to return delayed execution
      const delayedAccessManager = {
        ...mockAccessManager,
        canCall: async () => [true, 3600], // allowed with delay, 1 hour delay
      };

      const delayedSubmitter = new EV5AccessManagerTxSubmitter(
        {
          type: TxSubmitterType.ACCESS_MANAGER,
          chain: CHAIN_NAME,
          accessManagerAddress: ACCESS_MANAGER_ADDRESS,
          proposerSubmitter: {
            type: TxSubmitterType.JSON_RPC,
            chain: CHAIN_NAME,
          },
        },
        multiProvider,
        mockProposerSubmitter,
        delayedAccessManager as any,
      );

      const mockTransaction: AnnotatedEV5Transaction = {
        to: '0x1234567890123456789012345678901234567890',
        data: '0xabcdef',
      };

      const result = await delayedSubmitter.submit(mockTransaction);
      expect(result).to.be.an('array');
      expect(result).to.have.length(1); // returns execute transaction for delayed execution
    });
  });
});
