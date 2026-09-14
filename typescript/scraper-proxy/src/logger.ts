import { rootLogger } from '@hyperlane-xyz/utils';

export class Logger {
  private readonly logger;

  constructor(context: string) {
    this.logger = rootLogger.child({ module: context });
  }

  debug(message: string): void {
    this.logger.debug(message);
  }

  error(message: string): void {
    this.logger.error(message);
  }

  log(message: string): void {
    this.logger.info(message);
  }

  warn(message: string): void {
    this.logger.warn(message);
  }
}
