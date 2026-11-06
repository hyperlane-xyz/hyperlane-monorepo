import { expect } from 'chai';
import { ethers } from 'ethers';
import type { ProcessPromise } from 'zx';
import { $ } from 'zx';

import {
  ILayerZeroPacketService__factory,
  Mailbox__factory,
  MockLayerZeroEndpointV2__factory,
  MockLayerZeroUln302__factory,
  TestRecipient__factory,
} from '@hyperlane-xyz/core';
import type { ChainAddresses } from '@hyperlane-xyz/registry';
import {
  EvmLayerZeroV2HookIsmModule,
  EvmLayerZeroV2HookIsmReader,
  LayerZeroV2ConfigMode,
} from '@hyperlane-xyz/sdk';
import type {
  ChainMap,
  ChainName,
  LayerZeroV2MeshConfig,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';
import type { Address } from '@hyperlane-xyz/utils';

import { getContext } from '../../../context/context.js';
import { deployOrUseExistingCore } from '../commands/core.js';
import { hyperlaneSendMessage, hyperlaneStatus } from '../commands/helpers.js';
import {
  ANVIL_DEPLOYER_ADDRESS,
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from '../consts.js';

const CHAINS: ChainName[] = [CHAIN_NAME_2, CHAIN_NAME_3];
const DIRECTIONS: ReadonlyArray<readonly [ChainName, ChainName]> = [
  [CHAIN_NAME_2, CHAIN_NAME_3],
  [CHAIN_NAME_3, CHAIN_NAME_2],
];
const EIDS: ChainMap<number> = {
  [CHAIN_NAME_2]: 40_201,
  [CHAIN_NAME_3]: 40_202,
};
const SERVICE_PORT = 3_802;

interface LayerZeroFixture {
  endpoint: Address;
  library: Address;
}

interface LocalService {
  close(): Promise<void>;
}

function extract(output: string, label: string): string {
  const match = output.match(new RegExp(`${label}: (0x[a-fA-F0-9]{64})`));
  assert(match, `Could not extract ${label}`);
  return match[1];
}

async function startLayerZeroService(): Promise<LocalService> {
  const process: ProcessPromise = $({
    env: {
      ...globalThis.process.env,
      ENABLED_MODULES: 'layerzero',
      SERVER_PORT: String(SERVICE_PORT),
      REGISTRY_URI: REGISTRY_PATH,
      HYPERLANE_EXPLORER_URL: 'http://127.0.0.1:1',
    },
    nothrow: true,
  })`pnpm --filter @hyperlane-xyz/ccip-server run start`;

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${SERVICE_PORT}/health`);
      if (response.ok) break;
    } catch {
      // Server is still starting.
    }
    assert(Date.now() < deadline, 'LayerZero packet service did not start');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return { close: async () => process.kill() };
}

describe('LayerZero V2 combined hook/ISM message E2E', function () {
  this.timeout(10 * DEFAULT_E2E_TEST_TIMEOUT);

  let addresses: ChainMap<ChainAddresses>;
  let fixtures: ChainMap<LayerZeroFixture>;
  let multiProvider: MultiProvider;

  before(async () => {
    const cores = await Promise.all(
      CHAINS.map((chain) =>
        deployOrUseExistingCore(chain, CORE_CONFIG_PATH, ANVIL_KEY),
      ),
    );
    addresses = Object.fromEntries(
      CHAINS.map((chain, index) => [chain, cores[index]]),
    );
    ({ multiProvider } = await getContext({
      registryUris: [REGISTRY_PATH],
      key: ANVIL_KEY,
    }));
    fixtures = {};
    for (const chain of CHAINS) {
      multiProvider.setSigner(
        chain,
        new ethers.Wallet(ANVIL_KEY, multiProvider.getProvider(chain)),
      );
      const endpoint = await multiProvider.handleDeploy(
        chain,
        new MockLayerZeroEndpointV2__factory(),
        [EIDS[chain]],
      );
      const library = await multiProvider.handleDeploy(
        chain,
        new MockLayerZeroUln302__factory(),
        [endpoint.address],
      );
      await multiProvider.handleTx(
        chain,
        endpoint
          .connect(multiProvider.getSigner(chain))
          .registerMockLibrary(library.address),
      );
      fixtures[chain] = {
        endpoint: endpoint.address,
        library: library.address,
      };
    }
  });

  function mesh(urls: string[]): LayerZeroV2MeshConfig {
    return Object.fromEntries(
      CHAINS.map((chain) => {
        const remote = chain === CHAIN_NAME_2 ? CHAIN_NAME_3 : CHAIN_NAME_2;
        return [
          chain,
          {
            owner: ANVIL_DEPLOYER_ADDRESS,
            mailbox: addresses[chain].mailbox,
            endpoint: fixtures[chain].endpoint,
            layerZeroDomainId: EIDS[chain],
            urls,
            remoteRouters: {
              [remote]: {
                router: ethers.constants.AddressZero,
                layerZeroDomainId: EIDS[remote],
                sendLibrary: fixtures[chain].library,
                receiveLibrary: fixtures[chain].library,
                sendConfig: {
                  executor: { type: LayerZeroV2ConfigMode.Default },
                  uln: { type: LayerZeroV2ConfigMode.Default },
                },
                receiveConfig: { uln: { type: LayerZeroV2ConfigMode.Default } },
              },
            },
          },
        ];
      }),
    );
  }

  async function install(routers: ChainMap<Address>): Promise<void> {
    for (const chain of CHAINS) {
      const signer = multiProvider.getSigner(chain);
      await multiProvider.handleTx(
        chain,
        await Mailbox__factory.connect(
          addresses[chain].mailbox,
          signer,
        ).setDefaultHook(routers[chain]),
      );
      await multiProvider.handleTx(
        chain,
        await TestRecipient__factory.connect(
          addresses[chain].testRecipient,
          signer,
        ).setInterchainSecurityModule(routers[chain]),
      );
    }
  }

  async function send(origin: ChainName, destination: ChainName) {
    const result = await hyperlaneSendMessage(origin, destination, {
      quick: true,
    });
    const dispatchTx = extract(result.stdout, 'Dispatch TX');
    const messageId = extract(result.stdout, 'Message ID');
    const receipt = await multiProvider
      .getProvider(origin)
      .getTransactionReceipt(dispatchTx);
    const mailboxInterface = Mailbox__factory.createInterface();
    const dispatched = receipt.logs.flatMap((log) => {
      if (log.address.toLowerCase() !== addresses[origin].mailbox.toLowerCase())
        return [];
      let parsed;
      try {
        parsed = mailboxInterface.parseLog(log);
      } catch {
        return [];
      }
      if (parsed.name !== 'Dispatch') return [];
      const dispatchedMessage: unknown = parsed.args.message;
      assert(
        typeof dispatchedMessage === 'string',
        `Malformed Dispatch message in ${dispatchTx}`,
      );
      return [dispatchedMessage];
    });
    assert(dispatched.length === 1, 'Expected one Mailbox Dispatch event');
    const endpoint = MockLayerZeroEndpointV2__factory.connect(
      fixtures[origin].endpoint,
      multiProvider.getProvider(origin),
    );
    const packet = await endpoint.lastPacket();
    expect(packet.toLowerCase()).to.include(messageId.slice(2).toLowerCase());
    // PacketV1 header (81 bytes) and GUID (32 bytes) plus the packed 41-byte
    // authorization.
    expect(ethers.utils.arrayify(packet)).to.have.length(154);
    return { dispatchTx, messageId, message: dispatched[0] };
  }

  async function lookupPacket(
    router: Address,
    dispatchTx: string,
    message: string,
  ): Promise<Response> {
    return fetch(
      `http://127.0.0.1:${SERVICE_PORT}/layerzero/getLayerZeroPacket`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: router,
          signature: '0x',
          origin_tx_hash: dispatchTx,
          data: ILayerZeroPacketService__factory.createInterface().encodeFunctionData(
            'getLayerZeroPacket',
            [message],
          ),
        }),
      },
    );
  }

  async function assertDelivered(origin: ChainName, messageId: string) {
    const status = await hyperlaneStatus({ origin, messageId, quick: true });
    expect(status.stdout).to.include('delivered');
  }

  describe('CCIP-read delivery', () => {
    let routers: ChainMap<Address>;
    let service: LocalService;
    const serviceUrl = `http://127.0.0.1:${SERVICE_PORT}/layerzero/getLayerZeroPacket`;

    before(async () => {
      routers = await EvmLayerZeroV2HookIsmModule.deployMesh(
        multiProvider,
        mesh([serviceUrl]),
      );
      await install(routers);
      service = await startLayerZeroService();
    });

    after(async () => service?.close());

    for (const [origin, destination] of DIRECTIONS) {
      it(`relays ${origin} -> ${destination} through packet lookup`, async () => {
        const library = MockLayerZeroUln302__factory.connect(
          fixtures[destination].library,
          multiProvider.getSigner(destination),
        );
        await multiProvider.handleTx(
          destination,
          await library.setReady(false),
        );
        const { dispatchTx, messageId, message } = await send(
          origin,
          destination,
        );
        const pending = await hyperlaneStatus({
          origin,
          dispatchTx,
          relay: true,
          key: ANVIL_KEY,
        }).nothrow();
        expect(pending.exitCode).not.to.equal(0);

        await multiProvider.handleTx(destination, await library.setReady(true));
        expect(await library.ready()).to.be.true;
        const lookup = await lookupPacket(
          routers[destination],
          dispatchTx,
          message,
        );
        const lookupBody = await lookup.text();
        expect(lookup.ok, lookupBody).to.be.true;
        expect(JSON.parse(lookupBody).data).to.match(/^0x[0-9a-f]+$/i);
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
        await assertDelivered(origin, messageId);

        const derived = await new EvmLayerZeroV2HookIsmReader(
          multiProvider,
          destination,
        ).deriveLayerZeroConfig(routers[destination]);
        expect(derived.urls).to.deep.equal([serviceUrl]);
      });
    }
  });
});
