import { Argv } from 'yargs';

export function withRegistry<T>(args: Argv<T>) {
  return args
    .describe('registry', 'Github registry url')
    .string('registry')
    .array('registry');
}
