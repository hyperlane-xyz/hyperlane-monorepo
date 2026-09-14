import { expect } from 'chai';
import { ethers } from 'ethers';

import { Mailbox__factory } from '@hyperlane-xyz/core';
import { ModuleType, OnchainHookType } from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { resolveLayerZeroRoutes } from '../../src/services/layerZeroRouteResolver.js';
import type { LayerZeroRouterReader } from '../../src/services/layerZeroRouteResolver.js';
import {
  countMatchingHyperlaneDispatches,
  encodeLayerZeroPayload,
  findMatchingLayerZeroPacket,
  parseLayerZeroPacket,
  resolveLayerZeroReceiveLibrary,
} from '../../src/services/layerZeroPacketMatcher.js';

describe('resolveLayerZeroRoutes', () => {
  const originDomain = 1_000;
  const destinationDomain = 2_000;
  const originEid = 30_101;
  const destinationEid = 30_110;
  const originRouter = ethers.Wallet.createRandom().address;
  const destinationRouter = ethers.Wallet.createRandom().address;

  function reader({
    domain,
    eid,
    peer,
    peerEid,
    moduleType,
  }: {
    domain: number;
    eid: number;
    peer: string;
    peerEid: number;
    moduleType: ModuleType;
  }): LayerZeroRouterReader {
    return {
      endpoint: async () => ethers.Wallet.createRandom().address,
      hookType: async () => OnchainHookType.LAYER_ZERO,
      localDomain: async () => domain,
      localEid: async () => eid,
      mailbox: async () => ethers.Wallet.createRandom().address,
      moduleType: async () => moduleType,
      remoteConfigs: async () => peerEid,
      routers: async () => addressToBytes32(peer),
    };
  }

  function connector(originPeer = destinationRouter) {
    const readers = new Map<string, LayerZeroRouterReader>([
      [
        `${originDomain}:${originRouter.toLowerCase()}`,
        reader({
          domain: originDomain,
          eid: originEid,
          peer: originPeer,
          peerEid: destinationEid,
          moduleType: ModuleType.NULL,
        }),
      ],
      [
        `${destinationDomain}:${destinationRouter.toLowerCase()}`,
        reader({
          domain: destinationDomain,
          eid: destinationEid,
          peer: originRouter,
          peerEid: originEid,
          moduleType: ModuleType.CCIP_READ,
        }),
      ],
    ]);
    return (router: string, domain: number): LayerZeroRouterReader => {
      const result = readers.get(`${domain}:${router.toLowerCase()}`);
      if (!result) throw new Error(`Unexpected router ${router}`);
      return result;
    };
  }

  it('discovers a reciprocally enrolled route from the CCIP sender', async () => {
    const routes = await resolveLayerZeroRoutes(
      originDomain,
      destinationDomain,
      destinationRouter,
      connector(),
    );
    expect(routes.origin.router).to.equal(originRouter);
    expect(routes.origin.layerZeroDomainId).to.equal(originEid);
    expect(routes.destination.router).to.equal(destinationRouter);
    expect(routes.destination.layerZeroDomainId).to.equal(destinationEid);
  });

  it('rejects routes without reciprocal enrollment', async () => {
    let error: unknown;
    try {
      await resolveLayerZeroRoutes(
        originDomain,
        destinationDomain,
        destinationRouter,
        connector(ethers.Wallet.createRandom().address),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error)
      .to.be.an('error')
      .with.property('message')
      .that.includes('not reciprocally enrolled');
  });

  it('rejects a destination router that is not a CCIP-read ISM', async () => {
    const connect = connector();
    let error: unknown;
    try {
      await resolveLayerZeroRoutes(
        originDomain,
        destinationDomain,
        originRouter,
        (router, domain) =>
          domain === destinationDomain
            ? reader({
                domain,
                eid: destinationEid,
                peer: originRouter,
                peerEid: originEid,
                moduleType: ModuleType.NULL,
              })
            : connect(router, domain),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error)
      .to.be.an('error')
      .with.property('message')
      .that.includes('not a CCIP-read ISM');
  });
});

describe('layerZeroPacketMatcher', () => {
  const endpoint = ethers.Wallet.createRandom().address;
  const sender = addressToBytes32(ethers.Wallet.createRandom().address);
  const receiver = addressToBytes32(ethers.Wallet.createRandom().address);
  const sendLibrary = ethers.Wallet.createRandom().address;
  const sourceEid = 101;
  const destinationEid = 102;
  const nonce = 7;
  const messageId = ethers.utils.keccak256('0x1234');
  const payload = encodeLayerZeroPayload(1000, 2000, messageId);
  const guid = ethers.utils.solidityKeccak256(
    ['uint64', 'uint32', 'bytes32', 'uint32', 'bytes32'],
    [nonce, sourceEid, sender, destinationEid, receiver],
  );
  const packet = ethers.utils.solidityPack(
    [
      'uint8',
      'uint64',
      'uint32',
      'bytes32',
      'uint32',
      'bytes32',
      'bytes32',
      'bytes',
    ],
    [1, nonce, sourceEid, sender, destinationEid, receiver, guid, payload],
  );
  const iface = new ethers.utils.Interface([
    'event PacketSent(bytes encodedPayload,bytes options,address sendLibrary)',
  ]);
  const event = iface.encodeEventLog(iface.getEvent('PacketSent'), [
    packet,
    '0x0003',
    sendLibrary,
  ]);
  const log = { address: endpoint, topics: event.topics, data: event.data };

  it('parses the official V2 packet layout and validates its GUID', () => {
    const parsed = parseLayerZeroPacket(packet);
    expect(parsed.nonce).to.equal(7n);
    expect(parsed.payload).to.equal(payload);
    expect(parsed.payloadHash).to.equal(
      ethers.utils.keccak256(ethers.utils.hexConcat([guid, payload])),
    );
  });

  it('selects exactly the packet bound to the configured pathway', () => {
    const matched = findMatchingLayerZeroPacket([log], {
      endpoint,
      sourceEid,
      destinationEid,
      sender,
      receiver,
      payload,
    });
    expect(matched.packet).to.equal(packet);
    expect(matched.sendLibrary).to.equal(sendLibrary);
  });

  it('binds packet discovery to the exact Mailbox Dispatch event', () => {
    const mailboxAddress = ethers.Wallet.createRandom().address;
    const otherMailbox = ethers.Wallet.createRandom().address;
    const message = '0x1234';
    const mailbox = Mailbox__factory.createInterface();
    const dispatch = mailbox.encodeEventLog(mailbox.getEvent('Dispatch'), [
      ethers.Wallet.createRandom().address,
      2000,
      receiver,
      message,
    ]);
    const dispatchLog = {
      address: mailboxAddress,
      topics: dispatch.topics,
      data: dispatch.data,
    };
    expect(
      countMatchingHyperlaneDispatches([dispatchLog], mailboxAddress, message),
    ).to.equal(1);
    expect(
      countMatchingHyperlaneDispatches([dispatchLog], otherMailbox, message),
    ).to.equal(0);
    expect(
      countMatchingHyperlaneDispatches([dispatchLog], mailboxAddress, '0xabcd'),
    ).to.equal(0);
  });

  it('rejects absent and ambiguous matches', () => {
    expect(() =>
      findMatchingLayerZeroPacket([log], {
        endpoint,
        sourceEid: sourceEid + 1,
        destinationEid,
        sender,
        receiver,
        payload,
      }),
    ).to.throw('No matching LayerZero packet');
    expect(() =>
      findMatchingLayerZeroPacket([log, log], {
        endpoint,
        sourceEid,
        destinationEid,
        sender,
        receiver,
        payload,
      }),
    ).to.throw('Ambiguous LayerZero packets');
  });

  it('uses a ready grace library when the current library is pending', async () => {
    const current = ethers.Wallet.createRandom().address;
    const grace = ethers.Wallet.createRandom().address;
    const simulated: string[] = [];
    const selected = await resolveLayerZeroReceiveLibrary(
      {
        getReceiveLibrary: async () => [current, false],
        receiveLibraryTimeout: async () => [grace, 100],
        inboundPayloadHash: async () => ethers.constants.HashZero,
        isValidReceiveLibrary: async () => true,
      },
      {
        receiver,
        sourceEid,
        sender,
        nonce,
        payloadHash: ethers.utils.keccak256('0x1234'),
      },
      async (library) => {
        simulated.push(library);
        if (library === current) throw new Error('DVNs pending');
      },
    );
    expect(selected).to.equal(grace);
    expect(simulated).to.deep.equal([current, grace]);
  });

  it('accepts an already committed exact hash and rejects a conflict', async () => {
    const library = ethers.Wallet.createRandom().address;
    const payloadHash = ethers.utils.keccak256('0x1234');
    const endpoint = {
      getReceiveLibrary: async (): Promise<[string, boolean]> => [
        library,
        false,
      ],
      receiveLibraryTimeout: async (): Promise<[string, number]> => [
        ethers.constants.AddressZero,
        0,
      ],
      inboundPayloadHash: async () => payloadHash,
      isValidReceiveLibrary: async () => true,
    };
    expect(
      await resolveLayerZeroReceiveLibrary(
        endpoint,
        { receiver, sourceEid, sender, nonce, payloadHash },
        async () => {
          throw new Error('must not simulate');
        },
      ),
    ).to.equal(library);
    let error: unknown;
    try {
      await resolveLayerZeroReceiveLibrary(
        endpoint,
        {
          receiver,
          sourceEid,
          sender,
          nonce,
          payloadHash: ethers.utils.keccak256('0xabcd'),
        },
        async () => undefined,
      );
    } catch (caught) {
      error = caught;
    }
    expect(error)
      .to.be.an('error')
      .with.property(
        'message',
        'Endpoint contains a conflicting LayerZero payload hash',
      );
  });
});
