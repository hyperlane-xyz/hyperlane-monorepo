import { expect } from 'chai';
import sinon from 'sinon';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  EvmPrivateKeyQuoteSigner,
  EvmQuoteArtifactManager,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { SvmPrivateKeyQuoteSigner } from '@hyperlane-xyz/sealevel-sdk';

import {
  createDefaultQuoteSignerForChain,
  createQuoteArtifactManagerForChain,
} from '../../quote/factories.js';
import {
  HYP_KEY_BY_PROTOCOL,
  TEST_CHAIN_METADATA_BY_PROTOCOL,
} from '../constants.js';

const evmChainMetadata =
  TEST_CHAIN_METADATA_BY_PROTOCOL[ProtocolType.Ethereum].CHAIN_NAME_2;
const svmChainMetadata =
  TEST_CHAIN_METADATA_BY_PROTOCOL[ProtocolType.Sealevel].CHAIN_NAME_1;

// Protocols outside SUPPORTED_QUOTE_PROTOCOLS — both factories must return
// null. Tron shares the Ethereum branch and has no separate test-chain
// fixture, so it's not iterated here; the Ethereum case implicitly covers
// that code path.
const unsupportedChainMetadatas = [
  TEST_CHAIN_METADATA_BY_PROTOCOL[ProtocolType.CosmosNative].CHAIN_NAME_1,
  TEST_CHAIN_METADATA_BY_PROTOCOL[ProtocolType.Radix].CHAIN_NAME_1,
  TEST_CHAIN_METADATA_BY_PROTOCOL[ProtocolType.Starknet].CHAIN_NAME_1,
  TEST_CHAIN_METADATA_BY_PROTOCOL[ProtocolType.Aleo].CHAIN_NAME_1,
];

const FEE_ADDRESS = '0x0000000000000000000000000000000000001234';

// The EVM factory branch stores multiProvider on the constructed
// EvmQuoteArtifactManager but does not call into it; the cosmos branch
// returns null before reaching it. A bare stub satisfies both.
const multiProvider = sinon.createStubInstance(MultiProvider);

describe('createQuoteArtifactManagerForChain', () => {
  it('returns an EvmQuoteArtifactManager for an EVM chain', () => {
    const mgr = createQuoteArtifactManagerForChain({
      chainMetadata: evmChainMetadata,
      feeAddress: FEE_ADDRESS,
      context: { knownRoutersPerDomain: {} },
      multiProvider,
    });
    expect(mgr).to.be.instanceOf(EvmQuoteArtifactManager);
  });

  for (const chainMetadata of unsupportedChainMetadatas) {
    it(`returns null for ${chainMetadata.protocol}`, () => {
      const mgr = createQuoteArtifactManagerForChain({
        chainMetadata,
        feeAddress: FEE_ADDRESS,
        context: { knownRoutersPerDomain: {} },
        multiProvider,
      });
      expect(mgr).to.equal(null);
    });
  }
});

describe('createDefaultQuoteSignerForChain', () => {
  const evmKey = HYP_KEY_BY_PROTOCOL[ProtocolType.Ethereum];

  it('returns an EvmPrivateKeyQuoteSigner for an EVM chain', () => {
    const signer = createDefaultQuoteSignerForChain(evmChainMetadata, evmKey);
    expect(signer).to.be.instanceOf(EvmPrivateKeyQuoteSigner);
  });

  it('returns an SvmPrivateKeyQuoteSigner for a Sealevel chain', () => {
    const signer = createDefaultQuoteSignerForChain(svmChainMetadata, evmKey);
    expect(signer).to.be.instanceOf(SvmPrivateKeyQuoteSigner);
  });

  for (const chainMetadata of unsupportedChainMetadatas) {
    it(`returns null for ${chainMetadata.protocol}`, () => {
      expect(createDefaultQuoteSignerForChain(chainMetadata, evmKey)).to.equal(
        null,
      );
    });
  }
});
