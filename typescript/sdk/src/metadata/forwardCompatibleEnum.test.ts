import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { HookType } from '../hook/types.js';
import { IsmType } from '../ism/types.js';
import { TokenType } from '../token/config.js';
import { HypTokenConfigSchema } from '../token/types.js';

import {
  ChainMetadataSchema,
  ChainTechnicalStack,
  ExplorerFamily,
} from './chainMetadataTypes.js';
import { forwardCompatibleEnum } from './customZodTypes.js';

describe('forwardCompatibleEnum', () => {
  describe('ProtocolType normalization', () => {
    it('should parse known protocol types correctly', () => {
      const result = ChainMetadataSchema.safeParse({
        chainId: 1,
        domainId: 1,
        name: 'testchain',
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: 'https://rpc.example.com' }],
      });
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.protocol).to.equal(ProtocolType.Ethereum);
      }
    });

    it('should normalize unknown protocol types to ProtocolType.Unknown', () => {
      const result = ChainMetadataSchema.safeParse({
        chainId: 'test-chain-id',
        domainId: 12345,
        name: 'futurechain',
        protocol: 'futureprotocol', // A protocol that doesn't exist yet
        rpcUrls: [{ http: 'https://rpc.example.com' }],
      });
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.protocol).to.equal(ProtocolType.Unknown);
      }
    });
  });

  describe('ExplorerFamily normalization', () => {
    it('should parse known explorer families correctly', () => {
      const result = ChainMetadataSchema.safeParse({
        chainId: 1,
        domainId: 1,
        name: 'testchain',
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: 'https://rpc.example.com' }],
        blockExplorers: [
          {
            name: 'Explorer',
            url: 'https://explorer.example.com',
            apiUrl: 'https://api.explorer.example.com',
            family: ExplorerFamily.Etherscan,
          },
        ],
      });
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.blockExplorers?.[0].family).to.equal(
          ExplorerFamily.Etherscan,
        );
      }
    });

    it('should normalize unknown explorer families to ExplorerFamily.Unknown', () => {
      const result = ChainMetadataSchema.safeParse({
        chainId: 1,
        domainId: 1,
        name: 'testchain',
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: 'https://rpc.example.com' }],
        blockExplorers: [
          {
            name: 'FutureExplorer',
            url: 'https://explorer.example.com',
            apiUrl: 'https://api.explorer.example.com',
            family: 'newfamilytype', // An explorer family that doesn't exist yet
          },
        ],
      });
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.blockExplorers?.[0].family).to.equal(
          ExplorerFamily.Unknown,
        );
      }
    });
  });

  describe('ChainTechnicalStack normalization', () => {
    it('should parse known technical stacks correctly', () => {
      const result = ChainMetadataSchema.safeParse({
        chainId: 1,
        domainId: 1,
        name: 'testchain',
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: 'https://rpc.example.com' }],
        technicalStack: ChainTechnicalStack.OpStack,
      });
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.technicalStack).to.equal(
          ChainTechnicalStack.OpStack,
        );
      }
    });

    it('should normalize unknown technical stacks to ChainTechnicalStack.Unknown', () => {
      const result = ChainMetadataSchema.safeParse({
        chainId: 1,
        domainId: 1,
        name: 'testchain',
        protocol: ProtocolType.Ethereum,
        rpcUrls: [{ http: 'https://rpc.example.com' }],
        technicalStack: 'newfuturestack', // A technical stack that doesn't exist yet
      });
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.technicalStack).to.equal(
          ChainTechnicalStack.Unknown,
        );
      }
    });
  });

  describe('TokenType normalization', () => {
    it('should parse known token types correctly', () => {
      const result = HypTokenConfigSchema.safeParse({
        type: TokenType.collateral,
        token: '0x1234567890123456789012345678901234567890',
      });
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.type).to.equal(TokenType.collateral);
      }
    });

    it('should normalize unknown token types to TokenType.unknown', () => {
      const result = HypTokenConfigSchema.safeParse({
        type: 'futuretokentype', // A token type that doesn't exist yet
        token: '0x1234567890123456789012345678901234567890',
      });
      expect(result.success).to.be.true;
      if (result.success) {
        expect(result.data.type).to.equal(TokenType.unknown);
      }
    });
  });

  describe('forwardCompatibleEnum helper function', () => {
    const TestEnum = {
      Known: 'known',
      Another: 'another',
      Unknown: 'unknown',
    } as const;

    const schema = forwardCompatibleEnum(TestEnum, TestEnum.Unknown);

    it('should parse known values unchanged', () => {
      expect(schema.parse('known')).to.equal(TestEnum.Known);
      expect(schema.parse('another')).to.equal(TestEnum.Another);
    });

    it('should normalize unknown values to the specified unknown value', () => {
      expect(schema.parse('newvalue')).to.equal(TestEnum.Unknown);
      expect(schema.parse('anythingunknown')).to.equal(TestEnum.Unknown);
      expect(schema.parse('')).to.equal(TestEnum.Unknown);
    });

    it('should handle the Unknown value itself correctly', () => {
      expect(schema.parse('unknown')).to.equal(TestEnum.Unknown);
    });
  });

  describe('Unknown enum variants existence', () => {
    it('ProtocolType should have Unknown variant', () => {
      expect(ProtocolType.Unknown).to.equal('unknown');
    });

    it('ExplorerFamily should have Unknown variant', () => {
      expect(ExplorerFamily.Unknown).to.equal('unknown');
    });

    it('ChainTechnicalStack should have Unknown variant', () => {
      expect(ChainTechnicalStack.Unknown).to.equal('unknown');
    });

    it('TokenType should have unknown variant', () => {
      expect(TokenType.unknown).to.equal('unknown');
    });

    it('IsmType should have UNKNOWN variant', () => {
      expect(IsmType.UNKNOWN).to.equal('unknownIsm');
    });

    it('HookType should have UNKNOWN variant', () => {
      expect(HookType.UNKNOWN).to.equal('unknownHook');
    });
  });
});
