#!/usr/bin/env node
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { getValidatorKey, loadConfig } from '../config.js';
import { FastValidatorServer } from '../server.js';

const argv = await yargs(hideBin(process.argv))
  .option('config', {
    alias: 'c',
    type: 'string',
    demandOption: true,
    describe: 'Path to YAML config file',
  })
  .option('port', { alias: 'p', type: 'number', default: 8080 })
  .option('host', { alias: 'H', type: 'string', default: '0.0.0.0' })
  .strict()
  .parseAsync();

const config = loadConfig(argv.config);
const key = getValidatorKey();
const server = await FastValidatorServer.create(key, config);
server.start(argv.port, argv.host);
