import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  CctpService__factory,
  IMessageTransmitter__factory,
  Mailbox__factory,
} from '@hyperlane-xyz/core';
import { BaseMetadataBuilder, HyperlaneRelayer } from '@hyperlane-xyz/relayer';
import {
  type ChainMetadata,
  HookType,
  HyperlaneCore,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { readYamlOrJson } from '../../utils/files.js';

import { deployOrUseExistingCore } from './commands/core.js';
import {
  ANVIL_KEY,
  CHAIN_NAME_2,
  CHAIN_NAME_3,
  CORE_CONFIG_PATH,
  DEFAULT_E2E_TEST_TIMEOUT,
  REGISTRY_PATH,
} from './consts.js';

describe('SelfRelay E2E', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let serviceServer: any;
  let servicePort: number;
  let mockCctpServer: any;
  let mockCctpPort: number;
  let chain2Addresses: any;
  let chain3Addresses: any;
  let chain2Metadata: ChainMetadata;
  let chain3Metadata: ChainMetadata;
  let cctpApiCalled = false;

  before(async function () {
    // Deploy core on both chains
    [chain2Addresses, chain3Addresses] = await Promise.all([
      deployOrUseExistingCore(CHAIN_NAME_2, CORE_CONFIG_PATH, ANVIL_KEY),
      deployOrUseExistingCore(CHAIN_NAME_3, CORE_CONFIG_PATH, ANVIL_KEY),
    ]);

    chain2Metadata = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${CHAIN_NAME_2}/metadata.yaml`,
    );
    chain3Metadata = readYamlOrJson(
      `${REGISTRY_PATH}/chains/${CHAIN_NAME_3}/metadata.yaml`,
    );

    // Start mock CCTP attestation server
    const { createRequire } = await import('module');
    const require = createRequire(import.meta.url);
    const express = require('express');

    const mockApp = express();
    const mockAttestation = '0x' + 'ab'.repeat(65);
    const mockCctpMsg = '0x' + '00'.repeat(100);

    mockApp.get('/v1/messages/:sourceDomain/:txHash', (_req: any, res: any) => {
      cctpApiCalled = true;
      res.json({
        messages: [
          {
            attestation: mockAttestation,
            message: mockCctpMsg,
            eventNonce: '1',
          },
        ],
      });
    });

    mockApp.get('/v2/messages/:sourceDomain', (_req: any, res: any) => {
      cctpApiCalled = true;
      res.json({
        messages: [
          {
            attestation: mockAttestation,
            message: mockCctpMsg,
            eventNonce: '1',
            cctpVersion: '1',
            status: 'complete',
          },
        ],
      });
    });

    await new Promise<void>((resolve) => {
      mockCctpServer = mockApp.listen(0, () => {
        mockCctpPort = (mockCctpServer.address() as any).port;
        console.log(`Mock CCTP attestation server on port ${mockCctpPort}`);
        resolve();
      });
    });

    // Set up multiProvider with signer
    const multiProvider = new MultiProvider({
      [CHAIN_NAME_2]: chain2Metadata,
      [CHAIN_NAME_3]: chain3Metadata,
    });
    const wallet = new ethers.Wallet(ANVIL_KEY);
    multiProvider.setSharedSigner(wallet);

    // Create HyperlaneCore
    const chainAddresses: Record<string, any> = {
      [CHAIN_NAME_2]: chain2Addresses,
      [CHAIN_NAME_3]: chain3Addresses,
    };
    const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);

    // Create BaseMetadataBuilder with CCTP local resolver
    const builder = new BaseMetadataBuilder(core);

    const { CCTPAttestationService } =
      await import('../../../../ccip-server/dist/services/CCTPAttestationService.js');
    const cctpAttestationService = new CCTPAttestationService(
      'selfRelay',
      `http://localhost:${mockCctpPort}`,
    );
    const cctpIface = CctpService__factory.createInterface();
    const transmitterIface = IMessageTransmitter__factory.createInterface();

    builder.ccipReadMetadataBuilder.localResolver = async (
      context: any,
      _callData: any,
    ) => {
      const { dispatchTx, message } = context;

      let cctpMessage: string | undefined;
      for (const log of dispatchTx.logs) {
        try {
          const parsed = transmitterIface.parseLog(log);
          if (parsed.name === 'MessageSent') {
            cctpMessage = parsed.args.message;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!cctpMessage) return undefined;

      const [relayedMsg, attestation] =
        await cctpAttestationService.getAttestation(
          cctpMessage,
          dispatchTx.transactionHash,
          message.id,
          core.logger,
        );

      return cctpIface.encodeFunctionResult('getCCTPAttestation', [
        relayedMsg,
        attestation,
      ]);
    };

    // Create relayer (no merkle stub — TestISM uses NullMetadata)
    const relayer = new HyperlaneRelayer({ core, metadataBuilder: builder });

    // Create SelfRelayService and mount on Express
    const { SelfRelayService } =
      await import('../../../../ccip-server/dist/services/SelfRelayService.js');
    const service = new SelfRelayService({
      serviceName: 'selfRelay',
      relayer,
      multiProvider,
    });

    const app = express();
    app.use(express.json());
    app.use('/selfRelay', service.router);

    await new Promise<void>((resolve) => {
      serviceServer = app.listen(0, () => {
        servicePort = (serviceServer.address() as any).port;
        console.log(`SelfRelay service on port ${servicePort}`);
        resolve();
      });
    });
  });

  after(async function () {
    if (serviceServer) {
      await new Promise<void>((r) => serviceServer.close(() => r()));
    }
    if (mockCctpServer) {
      await new Promise<void>((r) => mockCctpServer.close(() => r()));
    }
  });

  it('should relay a cross-chain message via POST /relay', async function () {
    const provider = new ethers.providers.JsonRpcProvider(
      chain2Metadata.rpcUrls[0].http,
    );
    const signer = new ethers.Wallet(ANVIL_KEY).connect(provider);
    const mailbox = Mailbox__factory.connect(chain2Addresses.mailbox, signer);

    const body = ethers.utils.hexlify(
      ethers.utils.toUtf8Bytes('Hello self-relay'),
    );
    const destDomain = chain3Metadata.domainId!;
    const recipient = addressToBytes32(chain3Addresses.testRecipient);

    // Quote fee and dispatch
    const fee = await mailbox['quoteDispatch(uint32,bytes32,bytes)'](
      destDomain,
      recipient,
      body,
    );
    const tx = await mailbox['dispatch(uint32,bytes32,bytes)'](
      destDomain,
      recipient,
      body,
      { value: fee },
    );
    const receipt = await tx.wait();
    console.log(`Dispatched message, txHash: ${receipt.transactionHash}`);

    // Relay via SelfRelayService
    const response = await fetch(
      `http://localhost:${servicePort}/selfRelay/relay`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originChain: CHAIN_NAME_2,
          txHash: receipt.transactionHash,
        }),
      },
    );

    expect(response.ok).to.be.true;

    const result: any = await response.json();
    console.log('Relay result:', JSON.stringify(result, null, 2));

    expect(result.success).to.be.true;
    expect(result.messages).to.have.length(1);
    expect(result.messages[0].relayTxHash).to.be.a('string');
  });

  it('should resolve CCTP attestation via local resolver with mock API', async function () {
    const transmitterIface = IMessageTransmitter__factory.createInterface();
    const cctpIface = CctpService__factory.createInterface();

    // Create a mock CCTP v1 message: version=0 (4 bytes), sourceDomain=1 (4 bytes), + padding
    const cctpMessageBytes = '0x' + '00000000' + '00000001' + '00'.repeat(92);

    // Encode MessageSent event log
    const eventTopic = transmitterIface.getEventTopic('MessageSent');
    const eventData = ethers.utils.defaultAbiCoder.encode(
      ['bytes'],
      [cctpMessageBytes],
    );

    const mockTxHash = '0x' + 'aa'.repeat(32);
    const mockReceipt = {
      transactionHash: mockTxHash,
      logs: [
        {
          topics: [eventTopic],
          data: eventData,
          address: '0x' + '11'.repeat(20),
          logIndex: 0,
          blockNumber: 1,
          blockHash: '0x' + '00'.repeat(32),
          transactionHash: mockTxHash,
          transactionIndex: 0,
          removed: false,
        },
      ],
    };

    // Import CCTPAttestationService and create resolver
    const { CCTPAttestationService } =
      await import('../../../../ccip-server/dist/services/CCTPAttestationService.js');
    const cctpAttestationService = new CCTPAttestationService(
      'test',
      `http://localhost:${mockCctpPort}`,
    );

    const noopLogger: any = {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      child: () => noopLogger,
    };

    // Replicate the local resolver logic
    const localResolver = async (context: any) => {
      const { dispatchTx, message } = context;

      let cctpMessage: string | undefined;
      for (const log of dispatchTx.logs) {
        try {
          const parsed = transmitterIface.parseLog(log);
          if (parsed.name === 'MessageSent') {
            cctpMessage = parsed.args.message;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!cctpMessage) return undefined;

      const [relayedMsg, attestation] =
        await cctpAttestationService.getAttestation(
          cctpMessage,
          dispatchTx.transactionHash,
          message.id,
          noopLogger,
        );

      return cctpIface.encodeFunctionResult('getCCTPAttestation', [
        relayedMsg,
        attestation,
      ]);
    };

    // Reset flag
    cctpApiCalled = false;

    // Invoke with mock context containing CCTP MessageSent log
    const result = await localResolver({
      dispatchTx: mockReceipt,
      message: { id: '0x' + 'bb'.repeat(32) },
    });

    // Verify the mock CCTP API was called
    expect(cctpApiCalled).to.be.true;

    // Verify result is valid ABI-encoded metadata
    expect(result).to.be.a('string');
    expect(result).to.not.be.undefined;

    const decoded = cctpIface.decodeFunctionResult(
      'getCCTPAttestation',
      result!,
    );
    expect(decoded).to.have.length(2);
    console.log('CCTP local resolver returned valid encoded metadata');
  });

  it('should fall through when no CCTP MessageSent event present', async function () {
    const transmitterIface = IMessageTransmitter__factory.createInterface();
    const cctpIface = CctpService__factory.createInterface();

    const { CCTPAttestationService } =
      await import('../../../../ccip-server/dist/services/CCTPAttestationService.js');
    const cctpAttestationService = new CCTPAttestationService(
      'test',
      `http://localhost:${mockCctpPort}`,
    );

    const noopLogger: any = {
      info: () => {},
      error: () => {},
      warn: () => {},
      debug: () => {},
      child: () => noopLogger,
    };

    const localResolver = async (context: any) => {
      const { dispatchTx } = context;

      let cctpMessage: string | undefined;
      for (const log of dispatchTx.logs) {
        try {
          const parsed = transmitterIface.parseLog(log);
          if (parsed.name === 'MessageSent') {
            cctpMessage = parsed.args.message;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!cctpMessage) return undefined;

      const [relayedMsg, attestation] =
        await cctpAttestationService.getAttestation(
          cctpMessage,
          dispatchTx.transactionHash,
          'mockId',
          noopLogger,
        );

      return cctpIface.encodeFunctionResult('getCCTPAttestation', [
        relayedMsg,
        attestation,
      ]);
    };

    // Receipt with no CCTP logs
    cctpApiCalled = false;
    const result = await localResolver({
      dispatchTx: {
        transactionHash: '0x' + 'cc'.repeat(32),
        logs: [],
      },
    });

    expect(result).to.be.undefined;
    expect(cctpApiCalled).to.be.false;
    console.log('Resolver correctly falls through when no CCTP event');
  });
});
