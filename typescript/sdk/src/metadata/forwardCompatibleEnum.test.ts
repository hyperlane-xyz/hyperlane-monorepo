import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  HookType,
  SafeParseHookConfigSchema,
  normalizeUnknownHookTypes,
} from '../hook/types.js';
import {
  IsmType,
  SafeParseIsmConfigSchema,
  normalizeUnknownIsmTypes,
} from '../ism/types.js';
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

  describe('HookType normalization', () => {
    it('should parse known hook types correctly', () => {
      const result = SafeParseHookConfigSchema.safeParse({
        type: HookType.MERKLE_TREE,
      });
      expect(result.success).to.be.true;
      if (result.success && typeof result.data === 'object') {
        expect(result.data.type).to.equal(HookType.MERKLE_TREE);
      }
    });

    it('should normalize unknown hook types to HookType.UNKNOWN', () => {
      const result = SafeParseHookConfigSchema.safeParse({
        type: 'futureHookType',
        someOtherField: 'value',
      });
      expect(result.success).to.be.true;
      if (result.success && typeof result.data === 'object') {
        expect(result.data.type).to.equal(HookType.UNKNOWN);
      }
    });

    it('should normalize unknown hook types in nested configs', () => {
      const result = SafeParseHookConfigSchema.safeParse({
        type: HookType.AGGREGATION,
        hooks: [
          { type: HookType.MERKLE_TREE },
          { type: 'futureHookType', data: 'test' },
        ],
      });
      expect(result.success).to.be.true;
      if (
        result.success &&
        typeof result.data === 'object' &&
        result.data.type === HookType.AGGREGATION
      ) {
        const hooks = (result.data as { hooks: Array<{ type: string }> }).hooks;
        expect(hooks[0].type).to.equal(HookType.MERKLE_TREE);
        expect(hooks[1].type).to.equal(HookType.UNKNOWN);
      }
    });

    it('normalizeUnknownHookTypes should handle nested structures', () => {
      const config = {
        type: 'futureHookType',
        nested: {
          type: 'anotherFutureType',
        },
        array: [{ type: HookType.MERKLE_TREE }, { type: 'unknownType' }],
      };
      const normalized = normalizeUnknownHookTypes(config);
      expect(normalized.type).to.equal(HookType.UNKNOWN);
      expect(normalized.nested.type).to.equal(HookType.UNKNOWN);
      expect(normalized.array[0].type).to.equal(HookType.MERKLE_TREE);
      expect(normalized.array[1].type).to.equal(HookType.UNKNOWN);
    });
  });

  describe('IsmType normalization', () => {
    it('should parse known ISM types correctly', () => {
      const result = SafeParseIsmConfigSchema.safeParse({
        type: IsmType.TEST_ISM,
      });
      expect(result.success).to.be.true;
      if (result.success && typeof result.data === 'object') {
        expect(result.data.type).to.equal(IsmType.TEST_ISM);
      }
    });

    it('should normalize unknown ISM types to IsmType.UNKNOWN', () => {
      const result = SafeParseIsmConfigSchema.safeParse({
        type: 'futureIsmType',
        someOtherField: 'value',
      });
      expect(result.success).to.be.true;
      if (result.success && typeof result.data === 'object') {
        expect(result.data.type).to.equal(IsmType.UNKNOWN);
      }
    });

    it('should normalize unknown ISM types in nested configs', () => {
      const result = SafeParseIsmConfigSchema.safeParse({
        type: IsmType.AGGREGATION,
        modules: [
          { type: IsmType.TEST_ISM },
          { type: 'futureIsmType', data: 'test' },
        ],
        threshold: 1,
      });
      expect(result.success).to.be.true;
      if (
        result.success &&
        typeof result.data === 'object' &&
        result.data.type === IsmType.AGGREGATION
      ) {
        const modules = (result.data as { modules: Array<{ type: string }> })
          .modules;
        expect(modules[0].type).to.equal(IsmType.TEST_ISM);
        expect(modules[1].type).to.equal(IsmType.UNKNOWN);
      }
    });

    it('normalizeUnknownIsmTypes should handle nested structures', () => {
      const config = {
        type: 'futureIsmType',
        nested: {
          type: 'anotherFutureType',
        },
        array: [{ type: IsmType.TEST_ISM }, { type: 'unknownType' }],
      };
      const normalized = normalizeUnknownIsmTypes(config);
      expect(normalized.type).to.equal(IsmType.UNKNOWN);
      expect(normalized.nested.type).to.equal(IsmType.UNKNOWN);
      expect(normalized.array[0].type).to.equal(IsmType.TEST_ISM);
      expect(normalized.array[1].type).to.equal(IsmType.UNKNOWN);
    });
  });
});
