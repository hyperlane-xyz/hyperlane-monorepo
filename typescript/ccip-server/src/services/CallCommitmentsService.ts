import { Request, Response, Router } from 'express';

import {
  HyperlaneCore,
  encodeIcaCalls,
  normalizeCalls,
} from '@hyperlane-xyz/sdk';
import { commitmentFromIcaCalls } from '@hyperlane-xyz/sdk';

interface StoredCommitment {
  calls: { to: string; data: string; value?: string }[];
  salt: string;
  relayers: string[];
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
    const { calls, relayers, salt } = req.body;
    const key = commitmentFromIcaCalls(calls, salt);
    this.callCommitments.set(key, { calls, relayers, salt });
    console.log('Stored commitment', key);
    res.sendStatus(200);
  }

  public handleFetchCommitment(req: Request, res: Response) {
    const { data } = req.body;
    // strip selector + head
    const messageHex = '0x' + data.slice(2 + 8 + 128);
    const msg = HyperlaneCore.parseDispatchedMessage(messageHex);
    const body = msg.parsed.body;
    const key = '0x' + body.slice(68, 132);
    const entry = this.callCommitments.get(key);
    if (!entry) {
      console.log('Commitment not found', key);
      return res.status(404).json({ error: 'Commitment not found' });
    }
    const encoded = encodeIcaCalls(normalizeCalls(entry.calls), entry.salt);
    console.log('Serving calls for commitment', key);
    res.json({ data: encoded });
    return;
  }

  /**
   * Register routes onto an Express Router or app.
   */
  private registerRoutes(router: Router): void {
    router.post('/calls', this.handleCommitment.bind(this));
    router.post('/getCallsFromCommitment', this.handleFetchCommitment.bind(this));
  }
}
