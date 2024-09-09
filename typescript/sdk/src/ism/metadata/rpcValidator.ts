import { JsonRpcProvider, Provider } from '@ethersproject/providers';
import { Signer, ethers } from 'ethers';
import { joinSignature, splitSignature } from 'ethers/lib/utils.js';
import express from 'express';

import { Mailbox__factory, MerkleTreeHook__factory } from '@hyperlane-xyz/core';
import { DispatchEvent, DispatchIdEvent } from '@hyperlane-xyz/core/mailbox';
import {
  SignatureLike,
  WithAddress,
  addressToBytes32,
  assert,
  bytes32ToAddress,
  domainHash,
  fromHexString,
  strip0x,
  toHexString,
} from '@hyperlane-xyz/utils';

import { DispatchedMessage } from '../../index.js';
import { IsmType, RpcValidatorConfig } from '../types.js';

import { MetadataBuilder, MetadataContext } from './builder.js';

const SIGNATURE_LENGTH = 65;
const SIGNATURE_OFFSET = 32;

export interface RpcValidatorMultisigMetadata {
  type: IsmType.RPC_VALIDATOR;
  signatures: SignatureLike[];
  originMerkleTreeHook: string;
}

export interface RpcSignatureService {
  requestSignature(
    message: DispatchedMessage,
    dispatchTx: string,
    rpcUrl: string,
  ): Promise<RpcValidatorMultisigMetadata>;
}

export class RpcMetadataBuilder implements MetadataBuilder {
  static signatureAt(
    metadata: string,
    offset: number,
    index: number,
  ): SignatureLike | undefined {
    const buf = fromHexString(metadata);
    const start = offset + index * SIGNATURE_LENGTH;
    const end = start + SIGNATURE_LENGTH;
    if (end > buf.byteLength) {
      return undefined;
    }

    return toHexString(buf.subarray(start, end));
  }
  static decode(metadata: string): RpcValidatorMultisigMetadata {
    const buf = fromHexString(metadata);
    const originMerkleTreeHook = bytes32ToAddress(
      toHexString(buf.subarray(0, 32)),
    );
    const signatures: SignatureLike[] = [];
    for (let i = 0; this.signatureAt(metadata, SIGNATURE_OFFSET, i); i++) {
      const { r, s, v } = splitSignature(
        this.signatureAt(metadata, SIGNATURE_OFFSET, i)!,
      );
      signatures.push({ r, s, v });
    }

    return {
      type: IsmType.RPC_VALIDATOR,
      signatures,
      originMerkleTreeHook,
    };
  }

  static encode(metadata: RpcValidatorMultisigMetadata): string {
    let ret = addressToBytes32(metadata.originMerkleTreeHook);
    metadata.signatures.forEach((signature) => {
      const encodedSignature = joinSignature(signature);
      assert(
        fromHexString(encodedSignature).byteLength === SIGNATURE_LENGTH,
        'Invalid signature length',
      );
      ret += strip0x(encodedSignature);
    });
    return ret;
  }

  // @ts-ignore
  async build(
    context: MetadataContext<WithAddress<RpcValidatorConfig>>,
  ): Promise<string> {
    const signatures = await Promise.all(
      context.ism.validators.map(async (validator) => {
        const service = await this.getSignatureService(
          validator,
          context.ism.rpcUrl,
        );
        return service.requestSignature(
          context.message,
          context.dispatchTx.transactionHash,
          context.ism.rpcUrl,
        );
      }),
    );

    const metadata: RpcValidatorMultisigMetadata = {
      originMerkleTreeHook: context.ism.originMerkleTreeHook,
      signatures: signatures.flatMap((_) => _.signatures),
      type: IsmType.RPC_VALIDATOR,
    };

    return RpcMetadataBuilder.encode(metadata);
  }

  async getSignatureService(
    validator: string,
    rpcUrl: string,
  ): Promise<RpcSignatureService> {
    // TODO: directory service
    return Promise.resolve(
      new RemoteRpcValidatorSignerService('http://localhost:9191'),
    );
  }
}

export class RpcValidatorSignerService {
  async signMessage(
    message: DispatchedMessage,
    dispatchTx: string,
    rpcUrl: string,
    // Passing for mocking purposes
    provider: Provider,
    signer: Signer,
  ): Promise<RpcValidatorMultisigMetadata> {
    console.log('Attempt to sign for message', { message });
    // get events from dispatch tx
    // assert validity of the message
    // sign it
    const receipt = await provider.getTransactionReceipt(dispatchTx);

    const MailboxI = Mailbox__factory.createInterface();
    const MerkleTreeI = MerkleTreeHook__factory.createInterface();
    const parsedLogs = receipt.logs.map((log) => {
      try {
        return { address: log.address, parsed: MailboxI.parseLog(log) };
      } catch (error) {
        try {
          return { address: log.address, parsed: MerkleTreeI.parseLog(log) };
        } catch (error) {
          return null;
        }
      }
    });

    // TODO handle incorrect logs
    const dispatchEvent = parsedLogs.find((_) => _!.parsed.name === 'Dispatch')
      ?.parsed as unknown as DispatchEvent;
    const dispatchIdEvent = parsedLogs.find(
      (_) => _!.parsed.name === 'DispatchId',
    )?.parsed as unknown as DispatchIdEvent;
    const { address: merkleTreeHookAddrss, parsed: insertedIntoTreeEvent } =
      parsedLogs.find((_) => _!.parsed.name === 'InsertedIntoTree')!;

    // TODO check from mailbox
    if (dispatchEvent.args.message !== message.message) {
      throw new Error('Invalid message');
    }

    if (dispatchIdEvent.args.messageId !== message.id) {
      throw new Error('Invalid message id');
    }

    if (insertedIntoTreeEvent.args.messageId !== message.id) {
      throw new Error('Invalid message id');
    }

    console.log('Message is valid');
    const digest = this.getRpcDigest(message, merkleTreeHookAddrss, rpcUrl);
    const signature = await signer.signMessage(digest);
    const ret: RpcValidatorMultisigMetadata = {
      type: IsmType.RPC_VALIDATOR,
      originMerkleTreeHook: merkleTreeHookAddrss,
      signatures: [signature],
    };
    console.log('Respond with', ret);
    return ret;
  }

  getRpcDigest(
    message: DispatchedMessage,
    merkleTreeHookAddress: string,
    rpcUrl: string,
  ) {
    const hash = domainHash(message.parsed.origin, merkleTreeHookAddress);
    const types = ['bytes32', 'bytes32', 'string'];
    const preimage = ethers.utils.solidityPack(types, [
      hash,
      message.id,
      rpcUrl,
    ]);
    return ethers.utils.arrayify(ethers.utils.keccak256(preimage));
  }
}

export class RemoteRpcValidatorSignerService
  extends RpcValidatorSignerService
  implements RpcSignatureService
{
  constructor(public serviceUrl: string) {
    super();
  }
  async requestSignature(
    message: DispatchedMessage,
    dispatchTx: string,
    rpcUrl: string,
  ) {
    console.log('Fetching from rpc validator', {
      message,
      dispatchTx,
      rpcUrl,
      serviceUrl: this.serviceUrl,
    });
    const response = await fetch(this.serviceUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message,
        dispatchTx,
        rpcUrl,
      }),
    });
    if (!response.ok) {
      throw new Error('Failed to request signature');
    }
    return response.json();
  }
}

export class LocalRpcValidatorSignerService
  extends RpcValidatorSignerService
  implements RpcSignatureService
{
  public app: express.Express;
  constructor(public signer: Signer, port = process.env.PORT || 8080) {
    super();
    this.app = express();
    this.app.use(express.json());
    this.app.post('/', async (req, res) => {
      const { message, dispatchTx, rpcUrl } = req.body;
      const metadata = await this.requestSignature(message, dispatchTx, rpcUrl);
      res.json(metadata);
    });
    this.app.listen(port, () => {
      console.log(`RPC Validator running on port ${port}`);
    });
  }

  async requestSignature(
    message: DispatchedMessage,
    dispatchTx: string,
    rpcUrl: string,
  ) {
    const provider = new JsonRpcProvider(rpcUrl);
    return this.signMessage(message, dispatchTx, rpcUrl, provider, this.signer);
  }
}

export class MockRpcValidatorSignerService
  extends LocalRpcValidatorSignerService
  implements RpcSignatureService
{
  constructor(public provider: Provider, public signer: Signer, port: number) {
    super(signer, port);
  }
  async requestSignature(
    message: DispatchedMessage,
    dispatchTx: string,
    rpcUrl: string,
  ) {
    return this.signMessage(
      message,
      dispatchTx,
      rpcUrl,
      this.provider,
      this.signer,
    );
  }
}
