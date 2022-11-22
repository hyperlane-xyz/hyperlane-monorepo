import fetch from 'cross-fetch';
import { ethers } from 'ethers';

import {
  CircleBridgeAdapter__factory,
  ICircleBridge__factory,
  ICircleMessageTransmitter__factory,
  PortalAdapter__factory,
} from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../../HyperlaneApp';
import { Chains } from '../../consts/chains';
import { ChainNameToDomainId, DomainIdToChainName } from '../../domains';
import { LiquidityLayerContracts } from '../../middleware';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';

import { BridgeAdapterConfig } from './LiquidityLayerRouterDeployer';

const CircleBridgeInterface = ICircleBridge__factory.createInterface();
const CircleBridgeAdapterInterface =
  CircleBridgeAdapter__factory.createInterface();
const PortalAdapterInterface = PortalAdapter__factory.createInterface();

const BridgedTokenTopic = CircleBridgeAdapterInterface.getEventTopic(
  CircleBridgeAdapterInterface.getEvent('BridgedToken'),
);

const PortalBridgedTokenTopic = PortalAdapterInterface.getEventTopic(
  PortalAdapterInterface.getEvent('BridgedToken'),
);

interface CircleBridgeMessage<Chain> {
  chain: Chain;
  remoteChain: Chain;
  txHash: string;
  message: string;
  nonce: number;
  domain: number;
  nonceHash: string;
}

interface PortalBridgeMessage<Chain> {
  origin: Chain;
  nonce: number;
  portalSequence: number;
  destination: Chain;
}

export class LiquidityLayerApp<
  Chain extends ChainName = ChainName,
> extends HyperlaneApp<LiquidityLayerContracts, Chain> {
  constructor(
    public readonly contractsMap: ChainMap<Chain, LiquidityLayerContracts>,
    public readonly multiProvider: MultiProvider<Chain>,
    public readonly config: ChainMap<Chain, BridgeAdapterConfig>,
  ) {
    super(contractsMap, multiProvider);
  }

  async fetchCircleMessageTransactions(chain: Chain): Promise<string[]> {
    const cc = this.multiProvider.getChainConnection(chain);
    const params = new URLSearchParams({
      module: 'logs',
      action: 'getLogs',
      address: this.getContracts(chain).circleBridgeAdapter!.address,
      topic0: BridgedTokenTopic,
    });
    const req = await fetch(`${cc.getApiUrl()}?${params}`);
    const response = await req.json();

    return response.result.map((_: any) => _.transactionHash).flat();
  }

  async fetchPortalBridgeTransactions(chain: Chain): Promise<string[]> {
    const cc = this.multiProvider.getChainConnection(chain);
    const params = new URLSearchParams({
      module: 'logs',
      action: 'getLogs',
      address: this.getContracts(chain).portalAdapter!.address,
      topic0: PortalBridgedTokenTopic,
    });
    const req = await fetch(`${cc.getApiUrl()}?${params}`);
    const response = await req.json();

    return response.result.map((_: any) => _.transactionHash).flat();
  }

  async parsePortalMessages(
    chain: Chain,
    txHash: string,
  ): Promise<PortalBridgeMessage<Chain>[]> {
    const connection = this.multiProvider.getChainConnection(chain);
    const receipt = await connection.provider.getTransactionReceipt(txHash);
    const matchingLogs = receipt.logs
      .map((_) => {
        try {
          return [PortalAdapterInterface.parseLog(_)];
        } catch {
          return [];
        }
      })
      .flat();
    if (matchingLogs.length == 0) return [];

    const event = matchingLogs.find((_) => _!.name === 'BridgedToken')!;
    const portalSequence = event.args.portalSequence.toNumber();
    const nonce = event.args.nonce.toNumber();
    const destination = DomainIdToChainName[event.args.destination];
    // @ts-ignore
    return [{ origin: chain, nonce, portalSequence, destination }];
  }
  async parseCircleMessages(
    chain: Chain,
    txHash: string,
  ): Promise<CircleBridgeMessage<Chain>[]> {
    const connection = this.multiProvider.getChainConnection(chain);
    const receipt = await connection.provider.getTransactionReceipt(txHash);
    const matchingLogs = receipt.logs
      .map((_) => {
        try {
          return [CircleBridgeInterface.parseLog(_)];
        } catch {
          try {
            return [CircleBridgeAdapterInterface.parseLog(_)];
          } catch {
            return [];
          }
        }
      })
      .flat();

    if (matchingLogs.length == 0) return [];
    const message = matchingLogs.find((_) => _!.name === 'MessageSent')!.args
      .message;
    const nonce = matchingLogs.find((_) => _!.name === 'BridgedToken')!.args
      .nonce;
    const remoteChain = chain === Chains.fuji ? Chains.goerli : Chains.fuji;
    const domain = this.config[chain].circle!.circleDomainMapping.find(
      (_) => _.hyperlaneDomain === ChainNameToDomainId[chain],
    )!.circleDomain;
    return [
      {
        chain,
        // @ts-ignore
        remoteChain,
        txHash,
        message,
        nonce,
        domain,
        nonceHash: ethers.utils.solidityKeccak256(
          ['uint32', 'uint256'],
          [domain, nonce],
        ),
      },
    ];
  }

  async attemptPortalTransferCompletion(
    message: PortalBridgeMessage<Chain>,
  ): Promise<void> {
    const destinationPortalAdapter = this.getContracts(message.destination)
      .portalAdapter!;

    const transferId = await destinationPortalAdapter.transferId(
      ChainNameToDomainId[message.origin],
      message.nonce,
    );

    const transferMetadata =
      await destinationPortalAdapter.portalTransfersProcessed(transferId);

    if (transferMetadata.wormholeDomain != 0) {
      console.log(
        `Transfer with nonce ${message.nonce} from ${message.origin} to ${message.destination} already processed`,
      );
      return;
    }

    const wormholeOriginDomain = this.config[
      message.destination
    ].portal!.wormholeDomainMapping.find(
      (_) => _.hyperlaneDomain === ChainNameToDomainId[message.origin],
    )?.wormholeDomain;
    const emitter = utils.strip0x(
      utils.addressToBytes32(
        this.config[message.origin].portal!.portalBridgeAddress,
      ),
    );

    const vaa = await fetch(
      `https://wormhole-v2-testnet-api.certus.one/v1/signed_vaa/${wormholeOriginDomain}/${emitter}/${message.portalSequence}`,
    ).then((_) => _.json());

    if (vaa.code && vaa.code === 5) {
      console.log(`VAA not yet found for nonce ${message.nonce}`);
      return;
    }

    const connection = this.multiProvider.getChainConnection(
      message.destination,
    );
    console.log(
      `Complete portal transfer for nonce ${message.nonce} on ${message.destination}`,
    );
    await connection.handleTx(
      destinationPortalAdapter.completeTransfer(
        utils.ensure0x(Buffer.from(vaa.vaaBytes, 'base64').toString('hex')),
      ),
    );
  }
  async attemptCircleAttestationSubmission(
    message: CircleBridgeMessage<Chain>,
  ): Promise<void> {
    const connection = this.multiProvider.getChainConnection(
      message.remoteChain,
    );
    const transmitter = ICircleMessageTransmitter__factory.connect(
      this.config[message.remoteChain].circle!.messageTransmitterAddress,
      connection.signer!,
    );

    const alreadyProcessed = await transmitter.usedNonces(message.nonceHash);

    if (alreadyProcessed) {
      console.log(`Message sent on ${message.txHash} was already processed`);
      return;
    }

    const messageHash = ethers.utils.keccak256(message.message);
    const attestationsB = await fetch(
      `https://iris-api-sandbox.circle.com/attestations/${messageHash}`,
    );
    const attestations = await attestationsB.json();

    if (attestations.status !== 'complete') {
      console.log(
        `Attestations not available for message nonce ${message.nonce} on ${message.txHash}`,
      );
      return;
    }
    console.log(`Ready to submit attestations for message ${message.nonce}`);

    const tx = await transmitter.receiveMessage(
      message.message,
      attestations.attestation,
    );

    console.log(`Submitted attestations in ${await connection.getTxUrl(tx)}`);
    await connection.handleTx(tx);
  }
}
