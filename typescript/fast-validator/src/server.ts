import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import type { Logger } from 'pino';

import { createServiceLogger } from '@hyperlane-xyz/utils';

import packageJson from '../package.json' with { type: 'json' };

import { AppConfig } from './config.js';
import { SignRequestSchema } from './types.js';
import { VerificationError, Verifier } from './verifier.js';

export class FastValidatorServer {
  readonly app: Express;

  private constructor(
    private readonly verifier: Verifier,
    private readonly logger: Logger,
  ) {
    this.app = express();
    this.app.set('trust proxy', true);
    this.app.use(express.json({ limit: '1mb' }));
    this.registerRoutes();
  }

  static async create(
    privateKey: string,
    config: AppConfig,
  ): Promise<FastValidatorServer> {
    const logger = await createServiceLogger({
      service: 'fast-validator',
      version: packageJson.version,
    });
    const verifier = new Verifier(privateKey, config.chains, logger);
    logger.info(
      { address: verifier.address, chains: Object.keys(config.chains) },
      'fast-validator initialized',
    );
    return new FastValidatorServer(verifier, logger);
  }

  private registerRoutes() {
    this.app.get('/health', (_req, res) => {
      res.sendStatus(200);
    });

    this.app.get('/v1/address', (_req, res) => {
      res.json({ address: this.verifier.address });
    });

    this.app.get('/v1/chains', (_req, res) => {
      res.json({
        chains: this.verifier.listChains().map(({ name, config }) => ({
          name,
          domain: config.domain,
          mailbox: config.mailbox,
          merkleTreeHook: config.merkleTreeHook,
        })),
      });
    });

    this.app.post(
      '/v1/sign',
      async (req: Request, res: Response, next: NextFunction) => {
        try {
          const parsed = SignRequestSchema.safeParse(req.body);
          if (!parsed.success) {
            res
              .status(400)
              .json({ error: 'invalid request', issues: parsed.error.issues });
            return;
          }
          const result = await this.verifier.verifyAndSign(parsed.data);
          res.json(result);
        } catch (err) {
          next(err);
        }
      },
    );

    this.app.use(
      (err: Error, _req: Request, res: Response, _next: NextFunction) => {
        if (err instanceof VerificationError) {
          this.logger.warn(
            { reason: err.reason, detail: err.detail },
            'verification rejected',
          );
          res.status(422).json({ error: err.reason, detail: err.detail });
          return;
        }
        this.logger.error({ err }, 'internal error');
        res.status(500).json({ error: 'internal error' });
      },
    );
  }

  start(port: number, host = '0.0.0.0') {
    const server = this.app.listen(port, host, () => {
      this.logger.info({ port, host }, 'fast-validator listening');
    });
    const shutdown = () => {
      this.logger.info('shutting down…');
      server.close(() => process.exit(0));
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  }
}
