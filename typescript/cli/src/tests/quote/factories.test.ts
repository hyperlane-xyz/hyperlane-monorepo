import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import {
  EvmPrivateKeyQuoteSigner,
  EvmQuoteArtifactManager,
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
const cosmosChainMetadata =
  TEST_CHAIN_METADATA_BY_PROTOCOL[ProtocolType.CosmosNative].CHAIN_NAME_1;

const FEE_ADDRESS = '0x0000000000000000000000000000000000001234';

describe('createQuoteArtifactManagerForChain', () => {
  it('returns an EvmQuoteArtifactManager for an EVM chain', () => {
    const mgr = createQuoteArtifactManagerForChain({
      chainMetadata: evmChainMetadata,
      feeAddress: FEE_ADDRESS,
      context: { knownRoutersPerDomain: {} },
      multiProvider: {} as never,
      altVmSigners: {},
    });
    expect(mgr).to.be.instanceOf(EvmQuoteArtifactManager);
  });

  it('returns null for protocols without warp-quote support', () => {
    const mgr = createQuoteArtifactManagerForChain({
      chainMetadata: cosmosChainMetadata,
      feeAddress: FEE_ADDRESS,
      context: { knownRoutersPerDomain: {} },
      multiProvider: {} as never,
      altVmSigners: {},
    });
    expect(mgr).to.equal(null);
  });
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

  it('returns null for protocols without warp-quote support', () => {
    expect(
      createDefaultQuoteSignerForChain(cosmosChainMetadata, evmKey),
    ).to.equal(null);
  });
});
