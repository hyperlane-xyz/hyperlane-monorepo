import { error, logger } from '../logger.js';

//TODO remove
export function run(name: string, fn: () => Promise<any>) {
  logger(`Beginning ${name} script`);
  fn()
    .then(() => logger(`${name} completed successfully`))
    .catch((e: any) => {
      error(`Error running ${name}`, e);
      process.exit(1);
    });
}
