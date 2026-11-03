import { expect } from 'chai';
import { mock } from 'node:test';
import { pino } from 'pino';
import { getAddress, hexToBytes } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import {
  type DeployedRawWarpArtifact,
  TokenType as ArtifactTokenType,
} from '@hyperlane-xyz/provider-sdk/warp';
import { SvmWarpArtifactManager } from '@hyperlane-xyz/sealevel-sdk';
import {
  type DerivedTokenRouterConfig,
  EvmWarpRouteReader,
  HookType,
  HyperlaneCore,
  MultiProvider,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { QuoteMode } from '../../src/config.js';
import { EvmQuoteService } from '../../src/services/evmQuoteService.js';
import { SvmQuoteService } from '../../src/services/svmQuoteService.js';

const SIGNER_KEY = generatePrivateKey();
const SIGNER = privateKeyToAccount(SIGNER_KEY).address;
const ZERO = '0x0000000000000000000000000000000000000000';
const BASE58 = '11111111111111111111111111111111';
const LOGGER = pino({ level: 'silent' });
const DERIVED_CONFIG: DerivedTokenRouterConfig = {
  type: TokenType.native,
  owner: ZERO,
  mailbox: ZERO,
  interchainSecurityModule: ZERO,
  hook: {
    type: HookType.INTERCHAIN_GAS_PAYMASTER,
    address: ZERO,
    owner: ZERO,
    beneficiary: ZERO,
    oracleKey: ZERO,
    overhead: {},
    oracleConfig: {},
    quoteSigners: [SIGNER],
  },
};

function readGates() {
  const release: (() => void)[] = [];
  const reject: ((error: Error) => void)[] = [];
  let active = 0;
  let peak = 0;
  return {
    release,
    reject,
    get active() {
      return active;
    },
    get peak() {
      return peak;
    },
    async read() {
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve, fail) => {
          release.push(resolve);
          reject.push(fail);
        });
      } finally {
        active--;
      }
    },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('quote service route initialization', () => {
  afterEach(() => mock.restoreAll());

  for (const protocol of ['evm', 'svm'] as const) {
    function create(gates: ReturnType<typeof readGates>) {
      const multiProvider = MultiProvider.createTestMultiProvider();
      if (protocol === 'evm') {
        mock.method(
          EvmWarpRouteReader.prototype,
          'deriveWarpRouteConfig',
          async () => {
            await gates.read();
            return DERIVED_CONFIG;
          },
        );
        const routes = Array.from({ length: 8 }, (_, index) => ({
          origin: 'test1',
          // The last route duplicates the first with a different fee token.
          warpRouter: getAddress(
            `0x${(index === 7 ? 1 : index + 1).toString(16).padStart(40, '0')}`,
          ),
          quotedCallsAddress: ZERO,
          feeToken: getAddress(
            `0x${(index + 100).toString(16).padStart(40, '0')}`,
          ),
        }));
        return EvmQuoteService.create({
          signerKey: SIGNER_KEY,
          logger: LOGGER,
          multiProvider,
          core: new HyperlaneCore({}, multiProvider),
          routes,
        });
      }
      mock.method(
        SvmWarpArtifactManager.prototype,
        'readWarpToken',
        async (programId: string): Promise<DeployedRawWarpArtifact> => {
          await gates.read();
          return {
            artifactState: ArtifactState.DEPLOYED,
            config: {
              type: ArtifactTokenType.native,
              owner: BASE58,
              mailbox: BASE58,
              remoteRouters: {},
              destinationGas: {},
            },
            deployed: { address: programId },
          };
        },
      );
      return SvmQuoteService.create({
        signerKey: hexToBytes(SIGNER_KEY),
        logger: LOGGER,
        multiProvider,
        routes: Array.from({ length: 8 }, () => ({
          origin: 'solana',
          domainId: 1399811149,
          warpProgramId: BASE58,
          chainMetadata: {
            name: 'solana',
            protocol: ProtocolType.Sealevel,
            chainId: 1399811149,
            domainId: 1399811149,
            rpcUrls: [{ http: 'http://127.0.0.1:8899' }],
          },
        })),
      });
    }

    it(`${protocol}: bounds and refills route reads while retaining input-order overwrites`, async () => {
      const gates = readGates();
      const pending = create(gates);
      expect(gates.release.length).to.equal(4);
      gates.release[3]();
      await tick();
      expect(gates.release.length).to.equal(5);
      // Complete later routes first. The first input finishes last.
      for (const i of [1, 2, 4]) gates.release[i]();
      await tick();
      expect(gates.release.length).to.equal(8);
      for (const i of [5, 6, 7]) gates.release[i]();
      gates.release[0]();
      const service = await pending;
      expect(gates.peak).to.equal(4);
      expect(gates.active).to.equal(0);
      if (service instanceof EvmQuoteService) {
        const quote = await service.getIgpQuote({
          origin: 'test1',
          router: getAddress(`0x${'1'.padStart(40, '0')}`),
          destChainName: 'test2',
          destination: 9913372,
          sender: ZERO,
          txSubmitter: ZERO,
          binding: {
            kind: QuoteMode.TRANSIENT,
            salt: `0x${'0'.repeat(64)}`,
            transientBuffer: 0,
          },
        });
        expect(quote.details.quote.context.toLowerCase()).to.contain(
          (107).toString(16).padStart(40, '0'),
        );
      }
    });

    it(`${protocol}: stops admitting routes and drains active reads on failure`, async () => {
      const gates = readGates();
      let settled = false;
      const pending = create(gates).then(
        () => {
          settled = true;
          throw new Error('unexpected initialization success');
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      expect(gates.release.length).to.equal(4);
      const error = new Error('route snapshot RPC failed');
      gates.reject[0](error);
      await tick();
      expect(gates.release.length).to.equal(4);
      expect(settled).to.equal(false);
      for (const i of [1, 2, 3]) gates.release[i]();
      expect(await pending).to.equal(error);
      expect(gates.active).to.equal(0);
      expect(gates.release.length).to.equal(4);
    });
  }
});
