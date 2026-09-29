import { expect } from 'chai';

import { type ChainAddresses } from '@hyperlane-xyz/registry';
import {
  type ChainMap,
  type ChainName,
  type DerivedCoreConfig,
  EvmWormholeHookIsmModule,
  WormholeConsistencyLevel,
  WormholeConsistencyType,
  WormholeVariant,
} from '@hyperlane-xyz/sdk';
import { type Address, addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { getContext } from '../../../context/context.js';
import { writeYamlOrJson } from '../../../utils/files.js';
import {
  hyperlaneCoreApply,
  hyperlaneCoreDeploy,
  readCoreConfig,
} from '../commands/core.js';
import { hyperlaneSendMessage, hyperlaneStatus } from '../commands/helpers.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
  TEMP_PATH,
} from '../consts.js';

import {
  WH_CHAIN_ID_2,
  WH_CHAIN_ID_3,
  type WormholeChainFixture,
  buildMeshConfig,
  deployWormholeMesh,
  deployWormholeMocks,
  encodeMockVaa,
  getMultiProvider,
  readPublications,
  setRecipientIsm,
  startVaaUpstream,
  startWormholeVaaService,
  submitExecutorCallback,
} from './fixtures.js';

const DIRECTIONS: ReadonlyArray<readonly [ChainName, ChainName]> = [
  [CHAIN_NAME_2, CHAIN_NAME_3],
  [CHAIN_NAME_3, CHAIN_NAME_2],
];

// Second anvil account: an arbitrary submitter with no Executor relationship.
const RESCUER_KEY =
  '0x' +
  ['59c6995e998f97a5a0044966f0945389', 'dc9e86dae88c7a8412f4603b6b78690d'].join(
    '',
  );

const VAA_SERVICE_PORT = 3801;

function extractDispatchTx(output: string): string {
  const match = output.match(/Dispatch TX: (0x[a-fA-F0-9]{64})/);
  assert(match, 'Could not extract dispatch TX from send output');
  return match[1];
}

function extractMessageId(output: string): string {
  const match = output.match(/Message ID: (0x[a-fA-F0-9]{64})/);
  assert(match, 'Could not extract message ID from send output');
  return match[1];
}

describe('hyperlane wormhole hook/ISM e2e tests', function () {
  this.timeout(10 * DEFAULT_E2E_TEST_TIMEOUT);

  const chains: Array<ChainName> = [CHAIN_NAME_2, CHAIN_NAME_3];
  let addresses: ChainMap<ChainAddresses>;
  let mocks: ChainMap<WormholeChainFixture>;

  before(async function () {
    await hyperlaneCoreDeploy(CHAIN_NAME_2, CORE_CONFIG_PATH);
    await hyperlaneCoreDeploy(CHAIN_NAME_3, CORE_CONFIG_PATH);

    const { registry } = await getContext({
      registryUris: [REGISTRY_PATH],
      key: ANVIL_KEY,
    });
    const chainAddresses = await registry.getAddresses();
    addresses = {
      [CHAIN_NAME_2]: chainAddresses[CHAIN_NAME_2],
      [CHAIN_NAME_3]: chainAddresses[CHAIN_NAME_3],
    };

    const multiProvider = await getMultiProvider();
    mocks = {
      [CHAIN_NAME_2]: await deployWormholeMocks(
        multiProvider,
        CHAIN_NAME_2,
        WH_CHAIN_ID_2,
      ),
      [CHAIN_NAME_3]: await deployWormholeMocks(
        multiProvider,
        CHAIN_NAME_3,
        WH_CHAIN_ID_3,
      ),
    };
  });

  /**
   * Installs the deployed router as the Mailbox default hook through the
   * standard `hyperlane core read` -> edit -> `hyperlane core apply` flow, and
   * points the test application's ISM at the same address.
   */
  async function installRouters(routers: ChainMap<Address>): Promise<void> {
    const multiProvider = await getMultiProvider();

    for (const chain of chains) {
      const configPath = `${TEMP_PATH}/${chain}/wormhole-core-config.yaml`;
      const current = await readCoreConfig(chain, configPath);

      writeYamlOrJson(configPath, {
        ...current,
        // Combined hook/ISM routers are address-only in generic core configs;
        // their concrete Wormhole variant is recovered by the on-chain reader.
        defaultHook: routers[chain],
      });
      const applyResult = await hyperlaneCoreApply(chain, configPath).nothrow();
      assert(
        applyResult.exitCode === 0,
        `core apply failed on ${chain}:\n${applyResult.stdout}\n${applyResult.stderr}`,
      );

      // The core deployment gives TestRecipient its own ISM, so the Mailbox
      // default ISM is not consulted for it.
      await setRecipientIsm(
        multiProvider,
        chain,
        addresses[chain].testRecipient,
        routers[chain],
      );
    }
  }

  /** Asserts the read-back mesh is reciprocal and one address serves both roles. */
  async function assertMeshReadsBack(
    routers: ChainMap<Address>,
    variant: WormholeVariant,
  ): Promise<void> {
    const multiProvider = await getMultiProvider();
    const configs = await EvmWormholeHookIsmModule.readMesh(
      multiProvider,
      routers,
    );

    for (const chain of chains) {
      const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
      const config = configs[chain];

      expect(config.type).to.equal(variant);
      expect(config.owner).to.equal(ANVIL_DEPLOYER_ADDRESS);
      expect(config.core.toLowerCase()).to.equal(
        mocks[chain].core.address.toLowerCase(),
      );
      expect(config.consistencyLevel).to.deep.equal({
        type: WormholeConsistencyType.Finalized,
      });

      const route = config.remoteRouters[remote];
      expect(route, `${chain} does not enroll ${remote}`).to.not.be.undefined;
      expect(route.router.toLowerCase()).to.equal(
        routers[remote].toLowerCase(),
      );
      expect(route.wormholeChainId).to.equal(mocks[remote].wormholeChainId);
      expect(route.expectedConsistencyLevel).to.equal(
        WormholeConsistencyLevel.Finalized,
      );

      if (variant === WormholeVariant.Executor) {
        expect(config.executorQuoterRouter?.toLowerCase()).to.equal(
          mocks[chain].quoterRouter.address.toLowerCase(),
        );
        expect(route.quoter).to.not.be.undefined;
        expect(BigInt(route.callbackGasLimit ?? 0) > 0n).to.be.true;
      } else {
        expect(config.urls?.length).to.be.greaterThan(0);
      }

      // One deployed address serves as both the hook and the ISM.
      const core: DerivedCoreConfig = await readCoreConfig(
        chain,
        `${TEMP_PATH}/${chain}/wormhole-core-read.yaml`,
      );
      const defaultHook = core.defaultHook;
      assert(
        typeof defaultHook !== 'string',
        'Expected a structured default hook config',
      );
      expect(defaultHook.address?.toLowerCase()).to.equal(
        routers[chain].toLowerCase(),
      );
    }
  }

  /** Sends one message and asserts the origin published exactly one payload. */
  async function sendAndAssertPublication(
    origin: ChainName,
    destination: ChainName,
    routers: ChainMap<Address>,
  ) {
    const sendResult = await hyperlaneSendMessage(origin, destination, {
      quick: true,
    });
    const dispatchTx = extractDispatchTx(sendResult.stdout);
    const messageId = extractMessageId(sendResult.stdout);

    const multiProvider = await getMultiProvider();
    const publications = await readPublications(
      multiProvider,
      origin,
      dispatchTx,
      mocks[origin].core,
    );

    expect(
      publications.length,
      'expected exactly one Core publication',
    ).to.equal(1);
    const publication = publications[0];
    expect(publication.sender.toLowerCase()).to.equal(
      routers[origin].toLowerCase(),
    );
    expect(publication.consistencyLevel).to.equal(
      WormholeConsistencyLevel.Finalized,
    );

    // The payload binds this exact message to the destination router.
    expect(publication.payload.toLowerCase()).to.contain(
      messageId.slice(2).toLowerCase(),
    );
    expect(publication.payload.toLowerCase()).to.contain(
      addressToBytes32(routers[destination]).slice(2).toLowerCase(),
    );

    return { dispatchTx, messageId, publication };
  }

  describe('Executor variant', function () {
    let routers: ChainMap<Address>;

    before(async function () {
      const multiProvider = await getMultiProvider();
      const mesh = buildMeshConfig({
        variant: WormholeVariant.Executor,
        origin: mocks[CHAIN_NAME_2],
        destination: mocks[CHAIN_NAME_3],
        mailboxes: {
          [CHAIN_NAME_2]: addresses[CHAIN_NAME_2].mailbox,
          [CHAIN_NAME_3]: addresses[CHAIN_NAME_3].mailbox,
        },
        owner: ANVIL_DEPLOYER_ADDRESS,
      });

      routers = await deployWormholeMesh(multiProvider, mesh);
      await installRouters(routers);
    });

    it('reads back a reciprocal mesh with Executor delivery config', async function () {
      await assertMeshReadsBack(routers, WormholeVariant.Executor);
    });

    it('records an Executor request for each dispatch', async function () {
      const { publication } = await sendAndAssertPublication(
        CHAIN_NAME_2,
        CHAIN_NAME_3,
        routers,
      );

      const request = await mocks[CHAIN_NAME_2].quoterRouter.lastRequest();
      expect(request.dstChain).to.equal(WH_CHAIN_ID_3);
      expect(request.dstAddr.toLowerCase()).to.equal(
        addressToBytes32(routers[CHAIN_NAME_3]).toLowerCase(),
      );
      // ERV1 request carrying the sequence that was actually published.
      expect(request.requestBytes.toLowerCase()).to.contain(
        Buffer.from('ERV1').toString('hex'),
      );
      const sequenceHex = BigInt(publication.sequence)
        .toString(16)
        .padStart(16, '0');
      expect(request.requestBytes.toLowerCase().endsWith(sequenceHex)).to.be
        .true;
    });

    for (const [origin, destination] of DIRECTIONS) {
      it(`self-relays ${origin} -> ${destination} only after the callback`, async function () {
        const { dispatchTx, messageId, publication } =
          await sendAndAssertPublication(origin, destination, routers);

        // Before the callback the message is unauthorized, so self-relay fails.
        const before = await hyperlaneStatus({
          origin,
          dispatchTx,
          relay: true,
          key: ANVIL_KEY,
        }).nothrow();
        expect(
          before.exitCode,
          'self-relay must fail before the callback',
        ).to.not.equal(0);

        const multiProvider = await getMultiProvider();
        await submitExecutorCallback({
          multiProvider,
          chain: destination,
          router: routers[destination],
          encodedVaa: encodeMockVaa({
            emitterChainId: mocks[origin].wormholeChainId,
            emitterAddress: routers[origin],
            publication,
          }),
          rescuerKey: RESCUER_KEY,
        });

        const after = await hyperlaneStatus({
          origin,
          dispatchTx,
          relay: true,
          key: ANVIL_KEY,
        });
        expect(after.exitCode).to.equal(0);

        const status = await hyperlaneStatus({
          origin,
          messageId,
          quick: true,
        });
        expect(status.stdout).to.include('delivered');
      });
    }
  });

  describe('direct-VAA variant', function () {
    let routers: ChainMap<Address>;
    let upstream: Awaited<ReturnType<typeof startVaaUpstream>>;
    let service: Awaited<ReturnType<typeof startWormholeVaaService>>;
    const signedVaas = new Map<string, string>();

    before(async function () {
      upstream = await startVaaUpstream((vaaId) => signedVaas.get(vaaId));

      const multiProvider = await getMultiProvider();
      const serviceUrl = `http://127.0.0.1:${VAA_SERVICE_PORT}/wormhole/getWormholeVaa`;
      const mesh = buildMeshConfig({
        variant: WormholeVariant.DirectVaa,
        origin: mocks[CHAIN_NAME_2],
        destination: mocks[CHAIN_NAME_3],
        mailboxes: {
          [CHAIN_NAME_2]: addresses[CHAIN_NAME_2].mailbox,
          [CHAIN_NAME_3]: addresses[CHAIN_NAME_3].mailbox,
        },
        owner: ANVIL_DEPLOYER_ADDRESS,
        urls: [serviceUrl],
      });

      routers = await deployWormholeMesh(multiProvider, mesh);
      await installRouters(routers);

      service = await startWormholeVaaService({
        port: VAA_SERVICE_PORT,
        upstreamUrl: upstream.url,
        routes: {
          [CHAIN_NAME_2]: {
            core: mocks[CHAIN_NAME_2].core.address,
            wormholeChainId: WH_CHAIN_ID_2,
            router: routers[CHAIN_NAME_2],
          },
          [CHAIN_NAME_3]: {
            core: mocks[CHAIN_NAME_3].core.address,
            wormholeChainId: WH_CHAIN_ID_3,
            router: routers[CHAIN_NAME_3],
          },
        },
      });
    });

    after(async function () {
      await service?.close();
      await upstream?.close();
    });

    it('reads back a reciprocal mesh with CCIP-read URLs', async function () {
      await assertMeshReadsBack(routers, WormholeVariant.DirectVaa);
    });

    it('never asks the Executor Quoter Router for a quote', async function () {
      const before = (
        await mocks[CHAIN_NAME_2].quoterRouter.requestCount()
      ).toString();

      await sendAndAssertPublication(CHAIN_NAME_2, CHAIN_NAME_3, routers);

      const after = (
        await mocks[CHAIN_NAME_2].quoterRouter.requestCount()
      ).toString();
      expect(after).to.equal(before);
    });

    for (const [origin, destination] of DIRECTIONS) {
      it(`self-relays ${origin} -> ${destination} through the lookup service`, async function () {
        const { dispatchTx, messageId, publication } =
          await sendAndAssertPublication(origin, destination, routers);

        const emitter = addressToBytes32(routers[origin]).slice(2);
        const vaaId = `${mocks[origin].wormholeChainId}/${emitter}/${publication.sequence}`;

        // While the upstream has no VAA the relayer cannot build metadata, and
        // no delivery state is written.
        const pending = await hyperlaneStatus({
          origin,
          dispatchTx,
          relay: true,
          key: ANVIL_KEY,
        }).nothrow();
        expect(
          pending.exitCode,
          'self-relay must fail without a VAA',
        ).to.not.equal(0);

        signedVaas.set(
          vaaId,
          encodeMockVaa({
            emitterChainId: mocks[origin].wormholeChainId,
            emitterAddress: routers[origin],
            publication,
          }),
        );

        const relayed = await hyperlaneStatus({
          origin,
          dispatchTx,
          relay: true,
          key: ANVIL_KEY,
        }).nothrow();
        expect(
          relayed.exitCode,
          `self-relay failed:\n${relayed.stdout}\n${relayed.stderr}`,
        ).to.equal(0);

        const status = await hyperlaneStatus({
          origin,
          messageId,
          quick: true,
        });
        expect(status.stdout).to.include('delivered');

        // The service really was consulted rather than bypassed.
        expect(upstream.requestCount()).to.be.greaterThan(0);
      });
    }
  });
});
