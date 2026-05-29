import { expect } from 'chai';
import { Wallet } from 'ethers';
import { type z } from 'zod';

import {
  type ChainMetadata,
  DEFAULT_ROUTER_KEY,
  type TokenFeeConfigInputSchema,
  TokenFeeType,
  TokenType,
  type WarpCoreConfig,
  WarpRouteDeployConfigSchema,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

type TokenFeeInputShape = z.input<typeof TokenFeeConfigInputSchema>;

import { readYamlOrJson, writeYamlOrJson } from '../../../utils/files.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import {
  hyperlaneWarpDeploy,
  hyperlaneWarpQuoteCreateRaw,
  hyperlaneWarpQuoteReadRaw,
} from '../commands/warp.js';
import {
  ANVIL_KEY,
  CHAIN_3_METADATA_PATH,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  TEMP_PATH,
  WARP_CORE_CONFIG_PATH_2,
  WARP_DEPLOY_2_ID,
  WARP_DEPLOY_OUTPUT_PATH,
} from '../consts.js';

interface ReadResultEntry {
  destination: number;
  recipient: string;
  targetRouter: string;
  amount: string;
  maxFee: string;
  halfAmount: string;
  issuedAt: number;
  expiry: number;
}

const MAX_FEE = '1000000000';
const HALF_AMOUNT = '500000000';
const QUOTE_READ_OUTPUT_PATH = `${TEMP_PATH}/quote-read.yaml`;

const WILDCARD_BYTES32 =
  '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
const TARGET_ROUTER_NONE =
  '0x0000000000000000000000000000000000000000000000000000000000000000';

describe('hyperlane warp quote e2e tests', async function () {
  this.timeout(2 * DEFAULT_E2E_TEST_TIMEOUT);

  let chain3DomainId: number;
  let quoteSignerWallet: Wallet;
  let ownerAddress: string;

  before(async function () {
    await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    const chain3Metadata: ChainMetadata = readYamlOrJson(CHAIN_3_METADATA_PATH);
    chain3DomainId = chain3Metadata.domainId;

    ownerAddress = new Wallet(ANVIL_KEY).address;
    quoteSignerWallet = Wallet.createRandom();
  });

  async function deployWarpWithTokenFee(
    tokenFee: TokenFeeInputShape,
  ): Promise<void> {
    const warpConfig = WarpRouteDeployConfigSchema.parse({
      [CHAIN_NAME_2]: {
        type: TokenType.native,
        owner: ownerAddress,
        tokenFee,
      },
      [CHAIN_NAME_3]: {
        type: TokenType.synthetic,
        owner: ownerAddress,
      },
    });
    writeYamlOrJson(WARP_DEPLOY_OUTPUT_PATH, warpConfig);
    await hyperlaneWarpDeploy(WARP_DEPLOY_OUTPUT_PATH, WARP_DEPLOY_2_ID);
  }

  async function createStandingQuote(): Promise<void> {
    await hyperlaneWarpQuoteCreateRaw({
      warpRouteId: WARP_DEPLOY_2_ID,
      chain: CHAIN_NAME_2,
      destination: CHAIN_NAME_3,
      recipient: 'wildcard',
      amount: 'wildcard',
      maxFee: MAX_FEE,
      halfAmount: HALF_AMOUNT,
      ttl: 3600,
      quoteSignerKey: quoteSignerWallet.privateKey,
      privateKey: ANVIL_KEY,
    });
  }

  async function readStandingQuotes(
    chain?: string,
  ): Promise<Record<string, ReadResultEntry[]>> {
    await hyperlaneWarpQuoteReadRaw({
      warpRouteId: WARP_DEPLOY_2_ID,
      chain,
      out: QUOTE_READ_OUTPUT_PATH,
    });
    return readYamlOrJson(QUOTE_READ_OUTPUT_PATH);
  }

  function offchainQuotedLeaf(): TokenFeeInputShape {
    return {
      type: TokenFeeType.OffchainQuotedLinearFee,
      owner: ownerAddress,
      maxFee: 1_000_000_000n,
      halfAmount: 500_000_000n,
      quoteSigners: [quoteSignerWallet.address],
    };
  }

  describe('OffchainQuotedLinearFee (plain leaf)', () => {
    beforeEach(async () => {
      await deployWarpWithTokenFee(offchainQuotedLeaf());
    });

    it('standing quote create then read roundtrips', async () => {
      await createStandingQuote();
      const result = await readStandingQuotes();

      expect(result[CHAIN_NAME_2]).to.have.lengthOf(1);
      expect(result[CHAIN_NAME_3] ?? []).to.have.lengthOf(0);

      const [entry] = result[CHAIN_NAME_2];
      expect(entry.destination).to.equal(chain3DomainId);
      expect(entry.recipient).to.equal(WILDCARD_BYTES32);
      expect(entry.targetRouter).to.equal(TARGET_ROUTER_NONE);
      expect(entry.amount).to.equal('wildcard');
      expect(entry.maxFee).to.equal(MAX_FEE);
      expect(entry.halfAmount).to.equal(HALF_AMOUNT);
      expect(entry.expiry).to.be.greaterThan(entry.issuedAt);
    });

    it('transient quote (ttl=0) does not appear in standing quote read', async () => {
      await hyperlaneWarpQuoteCreateRaw({
        warpRouteId: WARP_DEPLOY_2_ID,
        chain: CHAIN_NAME_2,
        destination: CHAIN_NAME_3,
        recipient: 'wildcard',
        amount: 'wildcard',
        maxFee: MAX_FEE,
        halfAmount: HALF_AMOUNT,
        ttl: 0,
        quoteSignerKey: quoteSignerWallet.privateKey,
        privateKey: ANVIL_KEY,
      });

      const result = await readStandingQuotes();
      expect(result[CHAIN_NAME_2] ?? []).to.have.lengthOf(0);
    });

    it('quote read --chain filters output to a single chain', async () => {
      await createStandingQuote();

      const result = await readStandingQuotes(CHAIN_NAME_3);
      expect(Object.keys(result)).to.deep.equal([CHAIN_NAME_3]);
      expect(result[CHAIN_NAME_3] ?? []).to.have.lengthOf(0);
    });
  });

  describe('RoutingFee with OffchainQuotedLinearFee leaf', () => {
    beforeEach(async () => {
      await deployWarpWithTokenFee({
        type: TokenFeeType.RoutingFee,
        owner: ownerAddress,
        feeContracts: {
          [CHAIN_NAME_3]: offchainQuotedLeaf(),
        },
      });
    });

    it('standing quote create then read roundtrips with target=NONE', async () => {
      await createStandingQuote();
      const result = await readStandingQuotes();

      expect(result[CHAIN_NAME_2]).to.have.lengthOf(1);
      const [entry] = result[CHAIN_NAME_2];
      expect(entry.destination).to.equal(chain3DomainId);
      expect(entry.targetRouter).to.equal(TARGET_ROUTER_NONE);
      expect(entry.maxFee).to.equal(MAX_FEE);
    });
  });

  describe('CrossCollateralRoutingFee with OffchainQuotedLinearFee leaf', () => {
    beforeEach(async () => {
      await deployWarpWithTokenFee({
        type: TokenFeeType.CrossCollateralRoutingFee,
        owner: ownerAddress,
        feeContracts: {
          [CHAIN_NAME_3]: {
            [DEFAULT_ROUTER_KEY]: offchainQuotedLeaf(),
          },
        },
      });
    });

    it('standing quote create routes to default OQLF leaf and read returns the entry', async () => {
      await createStandingQuote();
      const result = await readStandingQuotes();

      const coreConfig: WarpCoreConfig = readYamlOrJson(
        WARP_CORE_CONFIG_PATH_2,
      );
      const destinationRouter = coreConfig.tokens.find(
        (t) => t.chainName === CHAIN_NAME_3,
      )?.addressOrDenom;
      assert(
        destinationRouter,
        `Missing destination router for ${CHAIN_NAME_3} in warp core config`,
      );

      expect(result[CHAIN_NAME_2]).to.have.lengthOf(1);
      const [entry] = result[CHAIN_NAME_2];
      expect(entry.destination).to.equal(chain3DomainId);
      expect(entry.targetRouter).to.equal(TARGET_ROUTER_NONE);
      expect(entry.maxFee).to.equal(MAX_FEE);
      expect(entry.halfAmount).to.equal(HALF_AMOUNT);
    });
  });
});
