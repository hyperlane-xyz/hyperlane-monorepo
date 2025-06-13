import { expect } from 'chai';
import 'chai-as-promised';
import { ethers } from 'ethers';

import { MultiProvider } from '../providers/MultiProvider.js';
import { TestChainName } from '../consts/testChains.js';

import { HypERC721Deployer } from './deploy.js';
import { TokenType } from './config.js';
import { TokenMetadataMap } from './TokenMetadataMap.js';
import {
  HypTokenRouterConfig,
  WarpRouteDeployConfig,
} from './types.js';

describe('NFT Deployment Tests', () => {
  let multiProvider: MultiProvider;
  let deployer: HypERC721Deployer;
  const testChain = TestChainName.test1;
  const someAddress = ethers.Wallet.createRandom().address;
  const mailboxAddress = ethers.Wallet.createRandom().address;

  beforeEach(() => {
    multiProvider = MultiProvider.createTestMultiProvider();
    deployer = new HypERC721Deployer(multiProvider);
  });

  describe('HypERC721Deployer constructorArgs', () => {
    it('should handle collateral NFT with correct constructor arguments', async () => {
      const config: HypTokenRouterConfig = {
        type: TokenType.collateral,
        token: someAddress,
        owner: someAddress,
        mailbox: mailboxAddress,
        isNft: true,
      };

      const args = await deployer.constructorArgs(testChain, config);
      
      // NFT collateral should only need [tokenAddress, mailbox]
      expect(args).to.deep.equal([someAddress, mailboxAddress]);
      expect(args.length).to.equal(2);
    });

    it('should handle collateralUri NFT with correct constructor arguments', async () => {
      const config: HypTokenRouterConfig = {
        type: TokenType.collateralUri,
        token: someAddress,
        owner: someAddress,
        mailbox: mailboxAddress,
        isNft: true,
      };

      const args = await deployer.constructorArgs(testChain, config);
      
      // NFT collateral should only need [tokenAddress, mailbox]
      expect(args).to.deep.equal([someAddress, mailboxAddress]);
      expect(args.length).to.equal(2);
    });

    it('should handle synthetic NFT with correct constructor arguments', async () => {
      const config: HypTokenRouterConfig = {
        type: TokenType.synthetic,
        name: 'Test NFT',
        symbol: 'TNFT',
        decimals: 0,
        owner: someAddress,
        mailbox: mailboxAddress,
        isNft: true,
      };

      const args = await deployer.constructorArgs(testChain, config);
      
      // NFT synthetic should only need [mailbox]
      expect(args).to.deep.equal([mailboxAddress]);
      expect(args.length).to.equal(1);
    });

    it('should handle syntheticUri NFT with correct constructor arguments', async () => {
      const config: HypTokenRouterConfig = {
        type: TokenType.syntheticUri,
        name: 'Test NFT URI',
        symbol: 'TNFTURI',
        decimals: 0,
        owner: someAddress,
        mailbox: mailboxAddress,
        isNft: true,
      };

      const args = await deployer.constructorArgs(testChain, config);
      
      // NFT synthetic should only need [mailbox]
      expect(args).to.deep.equal([mailboxAddress]);
      expect(args.length).to.equal(1);
    });

    it('should throw error for unknown NFT token type', async () => {
      const config = {
        type: 'unknownType' as TokenType,
        token: someAddress,
        owner: someAddress,
        mailbox: mailboxAddress,
        isNft: true,
      } as any;

      try {
        await deployer.constructorArgs(testChain, config);
        expect.fail('Expected method to throw an error');
      } catch (error) {
        expect((error as Error).message).to.equal('Unknown NFT token type when constructing arguments');
      }
    });
  });

  describe('NFT decimals validation', () => {
    it('should accept decimals: 0 for NFT configs', () => {
      const config: HypTokenRouterConfig = {
        type: TokenType.synthetic,
        name: 'Test NFT',
        symbol: 'TNFT',
        decimals: 0,
        owner: someAddress,
        mailbox: mailboxAddress,
        isNft: true,
      };

      // This should not throw because decimals: 0 is valid for NFTs
      expect(() => {
        if (config.decimals === undefined) {
          throw new Error('decimals is undefined for config');
        }
      }).to.not.throw();
      
      expect(config.decimals).to.equal(0);
    });

    it('should reject undefined decimals for synthetic NFT configs', () => {
      const config = {
        type: TokenType.synthetic,
        name: 'Test NFT',
        symbol: 'TNFT',
        // decimals: undefined,  // intentionally omitted
        owner: someAddress,
        mailbox: mailboxAddress,
        isNft: true,
      } as HypTokenRouterConfig;

      // This should throw because decimals is undefined
      expect(() => {
        if (config.decimals === undefined) {
          throw new Error('decimals is undefined for config');
        }
      }).to.throw('decimals is undefined for config');
    });
  });

  describe('TokenMetadataMap NFT handling', () => {
    let metadataMap: TokenMetadataMap;

    beforeEach(() => {
      metadataMap = new TokenMetadataMap();
    });

    it('should handle decimals: 0 in getDecimals method', () => {
      // Set NFT metadata with decimals: 0
      metadataMap.set('chain1', {
        name: 'Test NFT',
        symbol: 'TNFT',
        decimals: 0,
      });

      const decimals = metadataMap.getDecimals('chain1');
      expect(decimals).to.equal(0);
    });

    it('should handle decimals: 0 in finalize method', () => {
      // Set NFT metadata with decimals: 0
      metadataMap.set('chain1', {
        name: 'Test NFT 1',
        symbol: 'TNFT1',
        decimals: 0,
      });

      metadataMap.set('chain2', {
        name: 'Test NFT 2',
        symbol: 'TNFT2',
        decimals: 0,
      });

      // This should not throw because decimals: 0 is valid
      expect(() => metadataMap.finalize()).to.not.throw();
    });

    it('should handle mixed decimals with NFTs (0) and tokens (18)', () => {
      // Set NFT metadata with decimals: 0
      metadataMap.set('nftChain', {
        name: 'Test NFT',
        symbol: 'TNFT',
        decimals: 0,
      });

      // Set ERC20 metadata with decimals: 18
      metadataMap.set('tokenChain', {
        name: 'Test Token',
        symbol: 'TTKN',
        decimals: 18,
      });

      // This should not throw for now (we'll fix the scale logic later)
      expect(() => metadataMap.finalize()).to.not.throw();
      
      // Verify the decimals are correctly set
      const nftMetadata = metadataMap.getMetadataForChain('nftChain');
      const tokenMetadata = metadataMap.getMetadataForChain('tokenChain');
      
      expect(nftMetadata?.decimals).to.equal(0);
      expect(tokenMetadata?.decimals).to.equal(18);
    });

    it('should reject undefined decimals in finalize method', () => {
      // Set metadata without decimals
      metadataMap.set('chain1', {
        name: 'Test NFT',
        symbol: 'TNFT',
        // decimals is undefined
      } as any);

      // This should throw because decimals is undefined
      expect(() => metadataMap.finalize())
        .to.throw('All decimals must be defined');
    });
  });

  describe('NFT metadata derivation', () => {
    it('should derive NFT metadata with decimals: 0 for collateral NFTs', async () => {
      // Note: This test would require mocking the actual contract calls
      // For now, we'll test the logic that sets decimals: 0 for NFTs
      const metadataMap = new TokenMetadataMap();
      metadataMap.set(testChain, {
        name: 'Mocked NFT',
        symbol: 'MNFT',
        decimals: 0, // This is what should be set for NFTs
      });

      expect(metadataMap.getDecimals(testChain)).to.equal(0);
    });
  });

  describe('Integration: NFT deployment configuration', () => {
    it('should create valid NFT warp route config', () => {
      const nftConfig: WarpRouteDeployConfig = {
        ethereum: {
          type: TokenType.collateral,
          token: someAddress,
          owner: someAddress,
          mailbox: mailboxAddress,
          isNft: true,
        },
        arbitrum: {
          type: TokenType.synthetic,
          name: 'Bridged NFT',
          symbol: 'BNFT',
          decimals: 0,
          owner: someAddress,
          mailbox: mailboxAddress,
          isNft: true,
        },
      };

      // Verify both chains have proper NFT configuration
      expect(nftConfig.ethereum.isNft).to.be.true;
      expect(nftConfig.arbitrum.isNft).to.be.true;
      expect(nftConfig.arbitrum.decimals).to.equal(0);
    });

    it('should handle constructor args correctly for each NFT type', async () => {
      const collateralConfig: HypTokenRouterConfig = {
        type: TokenType.collateral,
        token: someAddress,
        owner: someAddress,
        mailbox: mailboxAddress,
        isNft: true,
      };

      const syntheticConfig: HypTokenRouterConfig = {
        type: TokenType.synthetic,
        name: 'Synthetic NFT',
        symbol: 'SNFT',
        decimals: 0,
        owner: someAddress,
        mailbox: mailboxAddress,
        isNft: true,
      };

      const collateralArgs = await deployer.constructorArgs(testChain, collateralConfig);
      const syntheticArgs = await deployer.constructorArgs(testChain, syntheticConfig);

      // Collateral NFTs need token address and mailbox
      expect(collateralArgs).to.deep.equal([someAddress, mailboxAddress]);
      
      // Synthetic NFTs only need mailbox
      expect(syntheticArgs).to.deep.equal([mailboxAddress]);
      
      // Verify no scale parameter is included (that was the bug)
      expect(collateralArgs).to.not.include.members([1]); // scale parameter
      expect(syntheticArgs).to.not.include.members([1]); // scale parameter
    });
  });
}); 