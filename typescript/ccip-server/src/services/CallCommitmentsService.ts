import { Request, Response, Router } from 'express';
import { z } from 'zod';

import { getRegistry } from '@hyperlane-xyz/registry/fs';
import {
  HyperlaneCore,
  encodeIcaCalls,
  normalizeCalls,
} from '@hyperlane-xyz/sdk';
import { commitmentFromIcaCalls } from '@hyperlane-xyz/sdk';
import { MultiProvider } from '@hyperlane-xyz/sdk';

import { CallCommitmentsAbi } from '../abis/CallCommitmentsAbi.js';
import { createAbiHandler } from '../utils/abiHandler.js';

import { BaseService } from './BaseService.js';

const postCallsSchema = z.object({
  calls: z
    .array(
      z.object({
        to: z.string(),
        data: z.string(),
        value: z.string().optional(),
      }),
    )
    .min(1),
  relayers: z.array(z.string()).min(0),
  salt: z.string(),
  ica: z.string(),
  commitmentDispatchTx: z.string(),
  originDomain: z.number(),
});

interface StoredCommitment {
  calls: { to: string; data: string; value?: string }[];
  salt: string;
  relayers: string[];
  ica: string;
  commitmentDispatchTx?: string;
}

// TODO: Authenticate relayer
// TODO: Check commitment was dispatched
export class CallCommitmentsService extends BaseService {
  private callCommitments: Map<string, StoredCommitment>;
  constructor(
    private multiProvider: MultiProvider,
    private core: HyperlaneCore,
  ) {
    super();
    this.callCommitments = new Map();
    this.registerRoutes(this.router);
  }

  static async initialize() {
    const registryUris = process.env.REGISTRY_URI;
    if (!registryUris) {
      throw new Error('REGISTRY_URI env var not set');
    }
    const registry = getRegistry({
      registryUris: registryUris.split(','),
      enableProxy: true,
    });
    const metadata = await registry.getMetadata();
    const multiProvider = new MultiProvider({ ...metadata });
    const chainAddresses = await registry.getAddresses();
    const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);
    return new CallCommitmentsService(multiProvider, core);
  }

  public async handleCommitment(req: Request, res: Response) {
    const parseResult = postCallsSchema.safeParse(req.body);
    if (!parseResult.success) {
      console.log('Invalid request', parseResult.error.flatten().fieldErrors);
      return res
        .status(400)
        .json({ errors: parseResult.error.flatten().fieldErrors });
    }
    const { calls, relayers, salt, ica, commitmentDispatchTx, originDomain } =
      parseResult.data;

    // Validate commitment was dispatched
    const provider = this.multiProvider.getProvider(originDomain);
    const tx = await provider.getTransactionReceipt(commitmentDispatchTx);
    const dispatchedMessages = this.core.getDispatchedMessages(tx);
    const commitment = commitmentFromIcaCalls(normalizeCalls(calls), salt);

    const wasCommitmentDispatched = dispatchedMessages.some((message) =>
      message.parsed.body
        .toLowerCase()
        .includes(commitment.slice(2).toLowerCase()),
    );
    if (!wasCommitmentDispatched) {
      console.log('Commitment not dispatched', commitment);
      return res.status(400).json({ error: 'Commitment not dispatched' });
    }

    this.callCommitments.set(commitment, { calls, relayers, salt, ica });
    console.log('Stored commitment', commitment);
    res.sendStatus(200);
    return;
  }

  public async handleFetchCommitment(commitment: string) {
    const entry = this.callCommitments.get(commitment);
    if (!entry) {
      console.log('Commitment not found', commitment);
      throw new Error('Commitment not found');
    }
    const encoded =
      entry.ica +
      encodeIcaCalls(normalizeCalls(entry.calls), entry.salt).slice(2);
    console.log('Serving calls for commitment', commitment);
    return Promise.resolve(encoded);
  }

  /**
   * Register routes onto an Express Router or app.
   */
  private registerRoutes(router: Router): void {
    router.post('/calls', this.handleCommitment.bind(this));
    router.post(
      '/getCallsFromCommitment',
      createAbiHandler(
        CallCommitmentsAbi,
        'getCallsFromCommitment',
        this.handleFetchCommitment.bind(this),
        true, // Skip ABI encoding of the result
      ),
    );
  }
}
