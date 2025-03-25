import { Argv } from 'yargs';

export function withRegistryUris<T>(args: Argv<T>) {
  return args
    .describe('registry', 'Github registry urls (comma separated)')
    .string('registry')
    .array('registry');
}
