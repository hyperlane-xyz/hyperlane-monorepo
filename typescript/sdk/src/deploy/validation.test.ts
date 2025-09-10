import { expect } from 'chai';
import { SinonStub, stub } from 'sinon';

import { HookType } from '../hook/types.js';
import { IsmType } from '../ism/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { EvmERC20WarpRouteReader } from '../token/EvmERC20WarpRouteReader.js';
import { TokenType } from '../token/config.js';
import {
  OwnerStatus,
  WarpRouteDeployConfigMailboxRequired,
} from '../token/types.js';

import {
  ValidationError,
  extractOwnersFromConfig,
  validateOwnerActivity,
  validateWarpDeployOwners,
} from './validation.js';

describe('Owner Validation', () => {
  let mockMultiProvider: MultiProvider;
  let validateOwnerAddressStub: SinonStub;

  beforeEach(() => {
    // Mock MultiProvider with required methods
    mockMultiProvider = {
      getProvider: () => ({}),
      getChainMetadata: () => ({ technicalStack: 'ethereum' }),
    } as unknown as MultiProvider;

    // Stub EvmERC20WarpRouteReader constructor and validateOwnerAddress
    validateOwnerAddressStub = stub(
      EvmERC20WarpRouteReader.prototype,
      'validateOwnerAddress',
    );
  });

  afterEach(() => {
    validateOwnerAddressStub.restore();
  });

  describe('extractOwnersFromConfig', () => {
    it('should extract basic owners from config', () => {
      const config: WarpRouteDeployConfigMailboxRequired = {
        ethereum: {
          owner: '0xEthereumOwner',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Ethereum',
          symbol: 'ETH',
        },
        arbitrum: {
          owner: '0xArbitrumOwner',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Arbitrum',
          symbol: 'ETH',
        },
      };

      const result = extractOwnersFromConfig(config);

      expect(result).to.deep.equal({
        ethereum: ['0xEthereumOwner'],
        arbitrum: ['0xArbitrumOwner'],
      });
    });

    it('should prioritize ownerOverrides over base owner', () => {
      const config: WarpRouteDeployConfigMailboxRequired = {
        ethereum: {
          owner: '0xBaseOwner',
          ownerOverrides: {
            ethereum: '0xOverrideOwner',
          },
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Ethereum',
          symbol: 'ETH',
        },
      };

      const result = extractOwnersFromConfig(config);

      expect(result.ethereum).to.contain('0xOverrideOwner');
      expect(result.ethereum).to.not.contain('0xBaseOwner');
    });

    it('should extract owners from proxy admin configurations', () => {
      const config: WarpRouteDeployConfigMailboxRequired = {
        ethereum: {
          owner: '0xBaseOwner',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Ethereum',
          symbol: 'ETH',
          interchainSecurityModule: {
            type: IsmType.ROUTING,
            owner: '0xIsmOwner',
            domains: {},
          },
          hook: {
            type: HookType.PROTOCOL_FEE,
            owner: '0xHookOwner',
            beneficiary: '0xBeneficiary',
            maxProtocolFee: '1000',
            protocolFee: '100',
          },
          proxyAdmin: {
            owner: '0xProxyOwner',
          },
        },
      };

      const result = extractOwnersFromConfig(config);

      expect(result.ethereum).to.have.length(2);
      expect(result.ethereum).to.contain('0xBaseOwner');
      expect(result.ethereum).to.contain('0xProxyOwner');
    });

    it('should handle configs without optional owner fields', () => {
      const config: WarpRouteDeployConfigMailboxRequired = {
        ethereum: {
          owner: '0xEthereumOwner',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Ethereum',
          symbol: 'ETH',
          // No ISM, hook, or proxyAdmin configs
        },
      };

      const result = extractOwnersFromConfig(config);

      expect(result.ethereum).to.deep.equal(['0xEthereumOwner']);
    });

    it('should remove duplicate owners', () => {
      const config: WarpRouteDeployConfigMailboxRequired = {
        ethereum: {
          owner: '0xSameOwner',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Ethereum',
          symbol: 'ETH',
          interchainSecurityModule: {
            type: IsmType.ROUTING,
            owner: '0xSameOwner', // Same as base owner
            domains: {},
          },
          proxyAdmin: {
            owner: '0xSameOwner', // Same as base owner
          },
        },
      };

      const result = extractOwnersFromConfig(config);

      expect(result.ethereum).to.deep.equal(['0xSameOwner']);
    });
  });

  describe('validateOwnerActivity', () => {
    it('should return Active status for active owner', async () => {
      validateOwnerAddressStub.resolves({
        '0xActiveOwner': OwnerStatus.Active,
      });

      const result = await validateOwnerActivity(
        'ethereum',
        '0xActiveOwner',
        mockMultiProvider,
      );

      expect(result).to.deep.equal({
        chain: 'ethereum',
        address: '0xActiveOwner',
        status: OwnerStatus.Active,
      });
    });

    it('should return GnosisSafe status for Gnosis Safe owner', async () => {
      validateOwnerAddressStub.resolves({
        '0xSafeOwner': OwnerStatus.GnosisSafe,
      });

      const result = await validateOwnerActivity(
        'ethereum',
        '0xSafeOwner',
        mockMultiProvider,
      );

      expect(result).to.deep.equal({
        chain: 'ethereum',
        address: '0xSafeOwner',
        status: OwnerStatus.GnosisSafe,
      });
    });

    it('should return Inactive status for inactive owner', async () => {
      validateOwnerAddressStub.resolves({
        '0xInactiveOwner': OwnerStatus.Inactive,
      });

      const result = await validateOwnerActivity(
        'ethereum',
        '0xInactiveOwner',
        mockMultiProvider,
      );

      expect(result).to.deep.equal({
        chain: 'ethereum',
        address: '0xInactiveOwner',
        status: OwnerStatus.Inactive,
      });
    });

    it('should throw error on network failures', async () => {
      validateOwnerAddressStub.rejects(new Error('Network failure'));

      try {
        await validateOwnerActivity('ethereum', '0xOwner', mockMultiProvider);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.equal('Network failure');
      }
    });
  });

  describe('validateWarpDeployOwners', () => {
    it('should succeed silently when all owners are valid', async () => {
      const config: WarpRouteDeployConfigMailboxRequired = {
        ethereum: {
          owner: '0xActiveOwner1',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Ethereum',
          symbol: 'ETH',
        },
        arbitrum: {
          owner: '0xActiveOwner2',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Arbitrum',
          symbol: 'ETH',
        },
      };

      validateOwnerAddressStub
        .withArgs('ethereum', '0xActiveOwner1')
        .resolves({ '0xActiveOwner1': OwnerStatus.Active })
        .withArgs('arbitrum', '0xActiveOwner2')
        .resolves({ '0xActiveOwner2': OwnerStatus.GnosisSafe });

      // Should not throw
      await validateWarpDeployOwners(config, mockMultiProvider);
    });

    it('should throw ValidationError when any owner is invalid', async () => {
      const config: WarpRouteDeployConfigMailboxRequired = {
        ethereum: {
          owner: '0xActiveOwner',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Ethereum',
          symbol: 'ETH',
        },
        arbitrum: {
          owner: '0xInactiveOwner',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Arbitrum',
          symbol: 'ETH',
        },
      };

      validateOwnerAddressStub
        .withArgs('ethereum', '0xActiveOwner')
        .resolves({ '0xActiveOwner': OwnerStatus.Active })
        .withArgs('arbitrum', '0xInactiveOwner')
        .resolves({ '0xInactiveOwner': OwnerStatus.Inactive });

      try {
        await validateWarpDeployOwners(config, mockMultiProvider);
        expect.fail('Should have thrown ValidationError');
      } catch (error) {
        expect(error).to.be.instanceOf(ValidationError);
        const validationError = error as ValidationError;
        expect(validationError.invalidOwners).to.have.length(1);
        expect(validationError.invalidOwners[0].chain).to.equal('arbitrum');
        expect(validationError.invalidOwners[0].address).to.equal(
          '0xInactiveOwner',
        );
        expect(validationError.invalidOwners[0].status).to.equal(
          OwnerStatus.Inactive,
        );
        expect(validationError.message).to.include('Found 1 invalid owner(s)');
      }
    });

    it('should handle multiple invalid owners', async () => {
      const config: WarpRouteDeployConfigMailboxRequired = {
        ethereum: {
          owner: '0xInactiveOwner1',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Ethereum',
          symbol: 'ETH',
        },
        arbitrum: {
          owner: '0xInactiveOwner2',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Arbitrum',
          symbol: 'ETH',
        },
      };

      validateOwnerAddressStub
        .withArgs('ethereum', '0xInactiveOwner1')
        .resolves({ '0xInactiveOwner1': OwnerStatus.Inactive })
        .withArgs('arbitrum', '0xInactiveOwner2')
        .resolves({ '0xInactiveOwner2': OwnerStatus.Error });

      try {
        await validateWarpDeployOwners(config, mockMultiProvider);
        expect.fail('Should have thrown ValidationError');
      } catch (error) {
        expect(error).to.be.instanceOf(ValidationError);
        const validationError = error as ValidationError;
        expect(validationError.invalidOwners).to.have.length(2);
        expect(validationError.message).to.include('Found 2 invalid owner(s)');
      }
    });

    it('should treat Skipped status as invalid', async () => {
      const config: WarpRouteDeployConfigMailboxRequired = {
        ethereum: {
          owner: '0xOwner',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Ethereum',
          symbol: 'ETH',
        },
      };

      validateOwnerAddressStub.resolves({ '0xOwner': OwnerStatus.Skipped });

      try {
        await validateWarpDeployOwners(config, mockMultiProvider);
        expect.fail('Should have thrown ValidationError');
      } catch (error) {
        expect(error).to.be.instanceOf(ValidationError);
        const validationError = error as ValidationError;
        expect(validationError.invalidOwners[0].status).to.equal(
          OwnerStatus.Skipped,
        );
      }
    });

    it('should handle configurations with multiple owners per chain', async () => {
      const config: WarpRouteDeployConfigMailboxRequired = {
        ethereum: {
          owner: '0xBaseOwner',
          mailbox: '0xMailbox',
          type: TokenType.native,
          decimals: 18,
          name: 'Ethereum',
          symbol: 'ETH',
          interchainSecurityModule: {
            type: IsmType.ROUTING,
            owner: '0xIsmOwner',
            domains: {},
          },
          proxyAdmin: {
            owner: '0xProxyOwner',
          },
        },
      };

      validateOwnerAddressStub
        .withArgs('ethereum', '0xBaseOwner')
        .resolves({ '0xBaseOwner': OwnerStatus.Active })
        .withArgs('ethereum', '0xProxyOwner')
        .resolves({ '0xProxyOwner': OwnerStatus.Inactive });

      try {
        await validateWarpDeployOwners(config, mockMultiProvider);
        expect.fail('Should have thrown ValidationError');
      } catch (error) {
        expect(error).to.be.instanceOf(ValidationError);
        const validationError = error as ValidationError;
        expect(validationError.invalidOwners).to.have.length(1);
        expect(validationError.invalidOwners[0].address).to.equal(
          '0xProxyOwner',
        );
      }
    });
  });
});
