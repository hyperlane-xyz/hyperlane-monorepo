import { expect } from 'chai';
import { ethers, type providers } from 'ethers';
import { pino } from 'pino';
import Sinon from 'sinon';

import type { MultiProtocolCore } from '@hyperlane-xyz/sdk';

import type {
  MCRStatusPollContext,
  MCRStatusRef,
} from '../../interfaces/ITokenBridgeStatusAdapter.js';
import { LzScanStatusAdapter, normalizeTxHash } from './LzScanStatusAdapter.js';

const logger = pino({ level: 'silent' });
const GUID = `0x${'11'.repeat(32)}`;
const OTHER_GUID = `0x${'22'.repeat(32)}`;
const ORIGIN_TX_HASH = `0x${'aa'.repeat(32)}`;
const DESTINATION_TX_HASH = `0x${'bb'.repeat(32)}`;
const SOURCE_EID = 30110;
const DESTINATION_EID = 30420;
const BRIDGE = '0x1234567890123456789012345678901234567890';
const SOURCE_OFT = '0x77652D5aba086137b595875263FC200182919B92';
const DESTINATION_OFT = '0x3a08f76772e200653bb55c2a92998daca62e0e97';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
const OFT_SENT_INTERFACE = new ethers.utils.Interface([
  'event OFTSent(bytes32 indexed guid,uint32 dstEid,address indexed fromAddress,uint256 amountSentLD,uint256 amountReceivedLD)',
]);
const OFT_RECEIVED_INTERFACE = new ethers.utils.Interface([
  'event OFTReceived(bytes32 indexed guid,uint32 srcEid,address indexed toAddress,uint256 amountReceivedLD)',
]);

function createAdapter(
  options: {
    maxRetries?: number;
    requestTimeoutMs?: number;
    retryDelayMs?: number;
  } = {},
): LzScanStatusAdapter {
  return new LzScanStatusAdapter({
    apiUrl: 'https://example.test/v1',
    logger,
    maxRetries: 1,
    ...options,
  });
}

function createRef(overrides: Record<string, unknown> = {}): MCRStatusRef {
  return {
    provider: 'lz_scan',
    kind: 'lz_scan',
    data: {
      originTxHash: ORIGIN_TX_HASH,
      destination: 'tron',
      destinationDomain: 728126428,
      guid: GUID,
      sourceEid: SOURCE_EID,
      destinationEid: DESTINATION_EID,
      sourceOft: SOURCE_OFT,
      destinationOft: DESTINATION_OFT,
      destinationRecipient: RECIPIENT,
      amountReceivedLD: '99',
      ...overrides,
    },
  };
}

function createMessage(overrides: Record<string, unknown> = {}) {
  return {
    guid: GUID,
    pathway: {
      srcEid: SOURCE_EID,
      dstEid: DESTINATION_EID,
      sender: { address: SOURCE_OFT },
      receiver: { address: DESTINATION_OFT },
    },
    source: { tx: { txHash: ORIGIN_TX_HASH } },
    status: { name: 'DELIVERED' },
    destination: {
      status: 'SUCCEEDED',
      tx: { txHash: DESTINATION_TX_HASH },
      lzCompose: { status: 'N/A' },
    },
    ...overrides,
  };
}

function stubResponse(body: unknown, status = 200): Sinon.SinonStub {
  return Sinon.stub(globalThis, 'fetch').callsFake(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

function createOftSentLog({
  amountReceivedLD = 99,
  destinationEid = DESTINATION_EID,
  emitter = SOURCE_OFT,
  fromAddress = BRIDGE,
}: {
  amountReceivedLD?: bigint | number | string;
  destinationEid?: number;
  emitter?: string;
  fromAddress?: string;
} = {}): providers.Log {
  const encoded = OFT_SENT_INTERFACE.encodeEventLog(
    OFT_SENT_INTERFACE.getEvent('OFTSent'),
    [GUID, destinationEid, fromAddress, 100, amountReceivedLD],
  );
  // CAST: Tests only require address, topics, and data log fields.
  return {
    address: emitter,
    topics: encoded.topics,
    data: encoded.data,
  } as providers.Log;
}

function createReceipt(logs: providers.Log[]): providers.TransactionReceipt {
  // CAST: Tests only exercise receipt hash/log parsing.
  return {
    transactionHash: ORIGIN_TX_HASH.slice(2),
    logs,
  } as providers.TransactionReceipt;
}

function createDestinationReceipt({
  amountReceivedLD = 99,
  blockNumber = 100,
  confirmations = 100,
  emitter = DESTINATION_OFT,
  guid = GUID,
  recipient = RECIPIENT,
  sourceEid = SOURCE_EID,
  status = 1,
}: {
  amountReceivedLD?: number;
  blockNumber?: number;
  confirmations?: number;
  emitter?: string;
  guid?: string;
  recipient?: string;
  sourceEid?: number;
  status?: number;
} = {}): providers.TransactionReceipt {
  const encoded = OFT_RECEIVED_INTERFACE.encodeEventLog(
    OFT_RECEIVED_INTERFACE.getEvent('OFTReceived'),
    [guid, sourceEid, recipient, amountReceivedLD],
  );
  // CAST: Tests only exercise destination receipt status, confirmation, and logs.
  return {
    blockNumber,
    status,
    confirmations,
    logs: [
      {
        address: emitter,
        topics: encoded.topics,
        data: encoded.data,
      } as providers.Log,
    ],
  } as providers.TransactionReceipt;
}

function createPollContext(
  receipt: providers.TransactionReceipt | null = createDestinationReceipt(),
  {
    blockTag,
    confirmedBlockNumber = 100,
    confirmations = 1,
    reorgPeriod = 'finalized',
  }: {
    blockTag?: string | number;
    confirmedBlockNumber?: number;
    confirmations?: number;
    reorgPeriod?: number | string;
  } = {},
): MCRStatusPollContext {
  const provider = {
    getTransactionReceipt: Sinon.stub().resolves(receipt),
    getBlock: Sinon.stub().resolves({ number: confirmedBlockNumber }),
  };
  // CAST: The adapter only consumes these MultiProtocolCore methods.
  const core = {
    multiProvider: {
      getChainName: Sinon.stub().returns('tron'),
      getEthersV5Provider: Sinon.stub().returns(provider),
    },
    metadata: Sinon.stub().returns({
      blocks: { confirmations, reorgPeriod },
    }),
  } as unknown as MultiProtocolCore;
  return { core, destination: 728126428, blockTag };
}

describe('LzScanStatusAdapter', () => {
  afterEach(() => Sinon.restore());

  it('extracts the exact OFTSent GUID and destination EID', async () => {
    const ref = await createAdapter().initFromReceipt({
      origin: 'arbitrum',
      destination: 'tron',
      originDomain: 42161,
      destinationDomain: 728126428,
      bridge: BRIDGE,
      sourceEid: SOURCE_EID,
      destinationEid: DESTINATION_EID,
      sourceOft: SOURCE_OFT,
      destinationOft: DESTINATION_OFT,
      destinationRecipient: RECIPIENT,
      sourceTokenDecimals: 6,
      destinationTokenDecimals: 6,
      minimumDestinationAmount: 99n,
      receipt: createReceipt([createOftSentLog()]),
    });

    expect(ref.data).to.include({
      originTxHash: ORIGIN_TX_HASH,
      guid: GUID,
      sourceEid: SOURCE_EID,
      destinationEid: DESTINATION_EID,
      sourceOft: SOURCE_OFT,
      destinationOft: DESTINATION_OFT,
      destinationRecipient: RECIPIENT,
      amountReceivedLD: '99',
      minimumDestinationAmount: '99',
    });
    expect(normalizeTxHash(`0X${'AA'.repeat(32)}`)).to.equal(
      `0x${'AA'.repeat(32)}`,
    );

    stubResponse({ data: [createMessage()] });
    expect(
      await createAdapter().pollStatus(ref, createPollContext()),
    ).to.include({
      status: 'complete',
      receivingTxHash: DESTINATION_TX_HASH,
    });
  });

  it('rejects OFTSent events not bound to the configured route', async () => {
    const logs = [
      createOftSentLog({ emitter: DESTINATION_OFT }),
      createOftSentLog({ fromAddress: RECIPIENT }),
      createOftSentLog({ destinationEid: SOURCE_EID }),
    ];

    for (const log of logs) {
      const ref = await createAdapter().initFromReceipt({
        origin: 'arbitrum',
        destination: 'tron',
        originDomain: 42161,
        destinationDomain: 728126428,
        bridge: BRIDGE,
        sourceEid: SOURCE_EID,
        destinationEid: DESTINATION_EID,
        sourceOft: SOURCE_OFT,
        destinationOft: DESTINATION_OFT,
        destinationRecipient: RECIPIENT,
        sourceTokenDecimals: 6,
        destinationTokenDecimals: 6,
        minimumDestinationAmount: 99n,
        receipt: createReceipt([log]),
      });
      expect(ref.data.guid).to.be.undefined;
      expect(ref.data.trackingError).to.equal(
        'Matching OFTSent event not found',
      );
    }
  });

  it('normalizes the received amount across local token decimals', async () => {
    const ref = await createAdapter().initFromReceipt({
      origin: 'arbitrum',
      destination: 'tron',
      originDomain: 42161,
      destinationDomain: 728126428,
      bridge: BRIDGE,
      sourceEid: SOURCE_EID,
      destinationEid: DESTINATION_EID,
      sourceOft: SOURCE_OFT,
      destinationOft: DESTINATION_OFT,
      destinationRecipient: RECIPIENT,
      sourceTokenDecimals: 18,
      destinationTokenDecimals: 6,
      minimumDestinationAmount: 99n,
      receipt: createReceipt([
        createOftSentLog({ amountReceivedLD: 99_000_000_000_000n }),
      ]),
    });

    expect(ref.data.amountReceivedLD).to.equal('99');
    stubResponse({ data: [createMessage()] });
    expect(
      await createAdapter().pollStatus(ref, createPollContext()),
    ).to.include({ status: 'complete' });
  });

  it('rejects a source event below the intended destination amount', async () => {
    const ref = await createAdapter().initFromReceipt({
      origin: 'arbitrum',
      destination: 'tron',
      originDomain: 42161,
      destinationDomain: 728126428,
      bridge: BRIDGE,
      sourceEid: SOURCE_EID,
      destinationEid: DESTINATION_EID,
      sourceOft: SOURCE_OFT,
      destinationOft: DESTINATION_OFT,
      destinationRecipient: RECIPIENT,
      sourceTokenDecimals: 6,
      destinationTokenDecimals: 6,
      minimumDestinationAmount: 99n,
      receipt: createReceipt([createOftSentLog({ amountReceivedLD: 98 })]),
    });

    expect(ref.data.guid).to.be.undefined;
    expect(ref.data.trackingError).to.equal('Matching OFTSent event not found');
  });

  it('rejects ambiguous matching OFTSent events', async () => {
    const ref = await createAdapter().initFromReceipt({
      origin: 'arbitrum',
      destination: 'tron',
      originDomain: 42161,
      destinationDomain: 728126428,
      bridge: BRIDGE,
      sourceEid: SOURCE_EID,
      destinationEid: DESTINATION_EID,
      sourceOft: SOURCE_OFT,
      destinationOft: DESTINATION_OFT,
      destinationRecipient: RECIPIENT,
      sourceTokenDecimals: 6,
      destinationTokenDecimals: 6,
      minimumDestinationAmount: 99n,
      receipt: createReceipt([createOftSentLog(), createOftSentLog()]),
    });

    expect(ref.data.guid).to.be.undefined;
    expect(ref.data.trackingError).to.equal('Multiple OFTSent events found');
  });

  it('keeps a confirmed source transaction suppressed when its GUID is unavailable', async () => {
    const adapter = createAdapter();
    const ref = await adapter.initFromReceipt({
      origin: 'arbitrum',
      destination: 'tron',
      originDomain: 42161,
      destinationDomain: 728126428,
      bridge: BRIDGE,
      sourceEid: SOURCE_EID,
      destinationEid: DESTINATION_EID,
      sourceOft: SOURCE_OFT,
      destinationOft: DESTINATION_OFT,
      destinationRecipient: RECIPIENT,
      sourceTokenDecimals: 6,
      destinationTokenDecimals: 6,
      minimumDestinationAmount: 99n,
      receipt: createReceipt([]),
    });
    const fetchStub = Sinon.stub(globalThis, 'fetch');

    expect(await adapter.pollStatus(ref, createPollContext())).to.include({
      status: 'pending',
      substatus: 'MANUAL_RECONCILIATION_REQUIRED',
    });
    expect(fetchStub.called).to.equal(false);
  });

  it('completes only the exact GUID, destination EID, and origin transaction', async () => {
    stubResponse({ data: [createMessage()] });

    const status = await createAdapter().pollStatus(
      createRef(),
      createPollContext(),
    );

    expect(status).to.include({
      status: 'complete',
      receivingTxHash: DESTINATION_TX_HASH,
    });
  });

  it('does not select a different message in a multi-message response', async () => {
    stubResponse({
      data: [
        createMessage({ guid: OTHER_GUID }),
        createMessage({
          pathway: {
            srcEid: SOURCE_EID,
            dstEid: SOURCE_EID,
            sender: { address: SOURCE_OFT },
            receiver: { address: DESTINATION_OFT },
          },
        }),
        createMessage({
          source: { tx: { txHash: `0x${'cc'.repeat(32)}` } },
        }),
        createMessage({
          pathway: {
            srcEid: SOURCE_EID,
            dstEid: DESTINATION_EID,
            sender: { address: DESTINATION_OFT },
            receiver: { address: DESTINATION_OFT },
          },
        }),
        createMessage({
          pathway: {
            srcEid: SOURCE_EID,
            dstEid: DESTINATION_EID,
            sender: { address: SOURCE_OFT },
            receiver: { address: SOURCE_OFT },
          },
        }),
      ],
    });

    expect(
      await createAdapter().pollStatus(createRef(), createPollContext()),
    ).to.include({
      status: 'pending',
      substatus: 'EXACT_MESSAGE_NOT_FOUND',
    });
  });

  it('waits for destination success and a destination transaction hash', async () => {
    stubResponse({
      data: [
        createMessage({
          destination: { status: 'VALIDATING_TX' },
        }),
      ],
    });
    expect(
      await createAdapter().pollStatus(createRef(), createPollContext()),
    ).to.include({
      status: 'pending',
      substatus: 'DELIVERED/VALIDATING_TX',
    });

    Sinon.restore();
    stubResponse({
      data: [
        createMessage({
          destination: { status: 'SUCCEEDED' },
        }),
      ],
    });
    expect(
      await createAdapter().pollStatus(createRef(), createPollContext()),
    ).to.include({
      status: 'pending',
      substatus: 'DELIVERED/SUCCEEDED',
    });
  });

  it('keeps LayerZero failure states pending for manual reconciliation', async () => {
    stubResponse({
      data: [
        createMessage({
          status: { name: 'FAILED' },
          destination: { status: 'SIMULATION_REVERTED' },
        }),
      ],
    });

    expect(
      await createAdapter().pollStatus(createRef(), createPollContext()),
    ).to.include({
      status: 'pending',
      substatus: 'FAILED/SIMULATION_REVERTED',
    });
  });

  it('requires an exact, successful, confirmed OFTReceived receipt', async () => {
    const cases: Array<providers.TransactionReceipt | null> = [
      null,
      createDestinationReceipt({ status: 0 }),
      createDestinationReceipt({ confirmations: 0 }),
      createDestinationReceipt({ emitter: SOURCE_OFT }),
      createDestinationReceipt({ guid: OTHER_GUID }),
      createDestinationReceipt({ sourceEid: DESTINATION_EID }),
      createDestinationReceipt({ recipient: BRIDGE }),
      createDestinationReceipt({ amountReceivedLD: 98 }),
    ];

    for (const receipt of cases) {
      Sinon.restore();
      stubResponse({ data: [createMessage()] });
      const status = await createAdapter().pollStatus(
        createRef(),
        createPollContext(receipt),
      );
      expect(status).to.include({
        status: 'pending',
        substatus: 'DESTINATION_RECEIPT_UNVERIFIED',
      });
    }
  });

  it('requires the destination receipt at the confirmed block tag', async () => {
    stubResponse({ data: [createMessage()] });
    expect(
      await createAdapter().pollStatus(
        createRef(),
        createPollContext(createDestinationReceipt({ blockNumber: 101 }), {
          blockTag: 100,
        }),
      ),
    ).to.include({
      status: 'pending',
      substatus: 'DESTINATION_RECEIPT_UNVERIFIED',
    });

    Sinon.restore();
    stubResponse({ data: [createMessage()] });
    expect(
      await createAdapter().pollStatus(
        createRef(),
        createPollContext(createDestinationReceipt({ blockNumber: 101 }), {
          blockTag: 'finalized',
          confirmedBlockNumber: 100,
        }),
      ),
    ).to.include({
      status: 'pending',
      substatus: 'DESTINATION_RECEIPT_UNVERIFIED',
    });
  });

  it('enforces the metadata finality tag without a caller block tag', async () => {
    stubResponse({ data: [createMessage()] });

    expect(
      await createAdapter().pollStatus(
        createRef(),
        createPollContext(createDestinationReceipt({ blockNumber: 101 }), {
          confirmedBlockNumber: 100,
          reorgPeriod: 'finalized',
        }),
      ),
    ).to.include({
      status: 'pending',
      substatus: 'DESTINATION_RECEIPT_UNVERIFIED',
    });
  });

  it('treats 404, malformed responses, and API outages as pending', async () => {
    stubResponse({}, 404);
    expect(
      (await createAdapter().pollStatus(createRef(), createPollContext()))
        .status,
    ).to.equal('pending');

    Sinon.restore();
    stubResponse({ data: [{ status: 'DELIVERED' }] });
    expect(
      (await createAdapter().pollStatus(createRef(), createPollContext()))
        .status,
    ).to.equal('pending');

    Sinon.restore();
    Sinon.stub(globalThis, 'fetch').rejects(new Error('temporary outage'));
    expect(
      (await createAdapter().pollStatus(createRef(), createPollContext()))
        .status,
    ).to.equal('pending');
  });

  it('queries LayerZero Scan by exact GUID', async () => {
    const fetchStub = stubResponse({ data: [] });

    await createAdapter().pollStatus(createRef(), createPollContext());

    expect(fetchStub.firstCall.args[0]).to.equal(
      `https://example.test/v1/messages/guid/${GUID}`,
    );
  });

  it('retries transient API errors', async () => {
    const fetchStub = Sinon.stub(globalThis, 'fetch');
    fetchStub.onFirstCall().resolves(new Response('', { status: 503 }));
    fetchStub.onSecondCall().resolves(
      new Response(JSON.stringify({ data: [createMessage()] }), {
        status: 200,
      }),
    );

    const status = await createAdapter({
      maxRetries: 2,
      retryDelayMs: 0,
    }).pollStatus(createRef(), createPollContext());

    expect(fetchStub.callCount).to.equal(2);
    expect(status.status).to.equal('complete');
  });

  it('aborts timed-out API requests and remains pending', async () => {
    const fetchStub = Sinon.stub(globalThis, 'fetch').callsFake(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );

    const status = await createAdapter({
      requestTimeoutMs: 1,
    }).pollStatus(createRef(), createPollContext());

    expect(fetchStub.calledOnce).to.equal(true);
    expect(status.status).to.equal('pending');
  });
});
