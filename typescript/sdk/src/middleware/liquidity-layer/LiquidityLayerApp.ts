import fetch from 'cross-fetch';
import { ethers } from 'ethers';

import {
  CircleBridgeAdapter__factory,
  ICircleMessageTransmitter__factory,
  ITokenMessenger__factory,
  PortalAdapter__factory,
} from '@hyperlane-xyz/core';
import { utils } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../../HyperlaneApp';
import { Chains } from '../../consts/chains';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';

import { BridgeAdapterConfig } from './LiquidityLayerRouterDeployer';
import { LiquidityLayerContracts } from './contracts';

const PORTAL_VAA_SERVICE_TESTNET_BASE_URL =
  'https://wormhole-v2-testnet-api.certus.one/v1/signed_vaa/';
const CIRCLE_ATTESTATIONS_BASE_URL =
  'https://iris-api-sandbox.circle.com/attestations/';

const PORTAL_VAA_SERVICE_SUCCESS_CODE = 5;

const TokenMessengerInterface = ITokenMessenger__factory.createInterface();
const CircleBridgeAdapterInterface =
  CircleBridgeAdapter__factory.createInterface();
const PortalAdapterInterface = PortalAdapter__factory.createInterface();

const BridgedTokenTopic = CircleBridgeAdapterInterface.getEventTopic(
  CircleBridgeAdapterInterface.getEvent('BridgedToken'),
);

const PortalBridgedTokenTopic = PortalAdapterInterface.getEventTopic(
  PortalAdapterInterface.getEvent('BridgedToken'),
);

interface CircleBridgeMessage {
  chain: ChainName;
  remoteChain: ChainName;
  txHash: string;
  message: string;
  nonce: number;
  domain: number;
  nonceHash: string;
}

interface PortalBridgeMessage {
  origin: ChainName;
  nonce: number;
  portalSequence: number;
  destination: ChainName;
}

export class LiquidityLayerApp extends HyperlaneApp<LiquidityLayerContracts> {
  constructor(
    public readonly contractsMap: ChainMap<LiquidityLayerContracts>,
    public readonly multiProvider: MultiProvider,
    public readonly config: ChainMap<BridgeAdapterConfig>,
  ) {
    super(contractsMap, multiProvider);
  }

  async fetchCircleMessageTransactions(chain: ChainName): Promise<string[]> {
    const url = new URL(this.multiProvider.getExplorerApiUrl(chain));
    url.searchParams.set('module', 'logs');
    url.searchParams.set('action', 'getLogs');
    url.searchParams.set(
      'address',
      this.getContracts(chain).circleBridgeAdapter!.address,
    );
    url.searchParams.set('topic0', BridgedTokenTopic);
    const req = await fetch(url);
    const response = await req.json();

    return response.result.map((_: any) => _.transactionHash).flat();
  }

  async fetchPortalBridgeTransactions(chain: ChainName): Promise<string[]> {
    const url = new URL(this.multiProvider.getExplorerApiUrl(chain));
    url.searchParams.set('module', 'logs');
    url.searchParams.set('action', 'getLogs');
    url.searchParams.set(
      'address',
      this.getContracts(chain).portalAdapter!.address,
    );
    url.searchParams.set('topic0', PortalBridgedTokenTopic);
    const req = await fetch(url);
    const response = await req.json();

    return response.result.map((_: any) => _.transactionHash).flat();
  }

  async parsePortalMessages(
    chain: ChainName,
    txHash: string,
  ): Promise<PortalBridgeMessage[]> {
    const provider = this.multiProvider.getProvider(chain);
    const receipt = await provider.getTransactionReceipt(txHash);
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
    const destination = this.multiProvider.getChainName(event.args.destination);

    return [{ origin: chain, nonce, portalSequence, destination }];
  }

  async parseCircleMessages(
    chain: ChainName,
    txHash: string,
  ): Promise<CircleBridgeMessage[]> {
    const provider = this.multiProvider.getProvider(chain);
    const receipt = await provider.getTransactionReceipt(txHash);
    const matchingLogs = receipt.logs
      .map((_) => {
        try {
          return [TokenMessengerInterface.parseLog(_)];
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
      (_) => _.hyperlaneDomain === this.multiProvider.getDomainId(chain),
    )!.circleDomain;
    return [
      {
        chain,
        remoteChain,
        txHash,
        message,
        nonce,
        domain,
        nonceHash: ethers.utils.solidityKeccak256(
          ['uint32', 'uint64'],
          [domain, nonce],
        ),
      },
    ];
  }

  async attemptPortalTransferCompletion(
    message: PortalBridgeMessage,
  ): Promise<void> {
    const destinationPortalAdapter = this.getContracts(message.destination)
      .portalAdapter!;

    const transferId = await destinationPortalAdapter.transferId(
      this.multiProvider.getDomainId(message.origin),
      message.nonce,
    );

    const transferTokenAddress =
      await destinationPortalAdapter.portalTransfersProcessed(transferId);

    if (!utils.eqAddress(transferTokenAddress, ethers.constants.AddressZero)) {
      console.log(
        `Transfer with nonce ${message.nonce} from ${message.origin} to ${message.destination} already processed`,
      );
      return;
    }

    const wormholeOriginDomain = this.config[
      message.destination
    ].portal!.wormholeDomainMapping.find(
      (_) =>
        _.hyperlaneDomain === this.multiProvider.getDomainId(message.origin),
    )?.wormholeDomain;
    const emitter = utils.strip0x(
      utils.addressToBytes32(
        this.config[message.origin].portal!.portalBridgeAddress,
      ),
    );

    const vaa = await fetch(
      `${PORTAL_VAA_SERVICE_TESTNET_BASE_URL}${wormholeOriginDomain}/${emitter}/${message.portalSequence}`,
    ).then((_) => _.json());

    if (vaa.code && vaa.code === PORTAL_VAA_SERVICE_SUCCESS_CODE) {
      console.log(`VAA not yet found for nonce ${message.nonce}`);
      return;
    }

    console.debug(
      `Complete portal transfer for nonce ${message.nonce} on ${message.destination}`,
    );

    try {
      await this.multiProvider.handleTx(
        message.destination,
        destinationPortalAdapter.completeTransfer(
          utils.ensure0x(Buffer.from(vaa.vaaBytes, 'base64').toString('hex')),
        ),
      );
    } catch (error: any) {
      if (
        error?.error?.reason?.includes('no wrapper for this token')
      ) {
        console.log(
          'No wrapper for this token, you should register the token at https://wormhole-foundation.github.io/example-token-bridge-ui/#/register',
        );
        console.log(message);
        return;
      }
      throw error;
    }
  }

  async attemptCircleAttestationSubmission(
    message: CircleBridgeMessage,
  ): Promise<void> {
    const signer = this.multiProvider.getSigner(message.remoteChain);
    const transmitter = ICircleMessageTransmitter__factory.connect(
      this.config[message.remoteChain].circle!.messageTransmitterAddress,
      signer,
    );

    const alreadyProcessed = await transmitter.usedNonces(message.nonceHash);

    if (alreadyProcessed) {
      console.log(`Message sent on ${message.txHash} was already processed`);
      return;
    }

    const messageHash = ethers.utils.keccak256(message.message);
    const attestationsB = await fetch(
      `${CIRCLE_ATTESTATIONS_BASE_URL}${messageHash}`,
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

    console.log(
      `Submitted attestations in ${this.multiProvider.tryGetExplorerTxUrl(
        message.remoteChain,
        tx,
      )}`,
    );
    await this.multiProvider.handleTx(message.remoteChain, tx);
  }
}
