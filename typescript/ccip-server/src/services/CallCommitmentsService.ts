import { Request, Response, Router } from 'express';

import { encodeIcaCalls, normalizeCalls } from '@hyperlane-xyz/sdk';
import { commitmentFromIcaCalls } from '@hyperlane-xyz/sdk';

import { CallCommitmentsAbi } from '../abis/CallCommitmentsAbi.js';
import { createAbiHandler } from '../utils/abiHandler.js';

interface StoredCommitment {
  calls: { to: string; data: string; value?: string }[];
  salt: string;
  relayers: string[];
  ica: string;
}

// TODO: Authenticate relayer
// TODO: Check commitment was dispatched
export class CallCommitmentsService {
  private callCommitments: Map<string, StoredCommitment>;
  public readonly router: Router;

  constructor() {
    this.callCommitments = new Map();
    this.router = Router();
    this.registerRoutes(this.router);
  }

  public handleCommitment(req: Request, res: Response) {
    const { calls, relayers, salt, ica } = req.body;
    const key = commitmentFromIcaCalls(calls, salt);
    this.callCommitments.set(key, { calls, relayers, salt, ica });
    console.log('Stored commitment', key);
    res.sendStatus(200);
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
