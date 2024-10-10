import { confirm, input } from '@inquirer/prompts';

import { WarpCoreConfig } from '@hyperlane-xyz/sdk';

import { readWarpCoreConfig } from '../config/warp.js';
import { CommandContext } from '../context/types.js';
import { logGray, logRed } from '../logger.js';

import { indentYamlOrJson } from './files.js';
import { selectRegistryWarpRoute } from './tokens.js';

export async function detectAndConfirmOrPrompt(
  detect: () => Promise<string | undefined>,
  prompt: string,
  label: string,
  source?: string,
): Promise<string> {
  let detectedValue: string | undefined;
  try {
    detectedValue = await detect();
    if (detectedValue) {
      const confirmed = await confirm({
        message: `Detected ${label} as ${detectedValue}${
          source ? ` from ${source}` : ''
        }, is this correct?`,
      });
      if (confirmed) {
        return detectedValue;
      }
    }
    // eslint-disable-next-line no-empty
  } catch (e) {}
  return input({ message: `${prompt} ${label}:`, default: detectedValue });
}

const INFO_COMMAND: string = 'i';
const DOCS_NOTICE: string =
  'For more information, please visit https://docs.hyperlane.xyz.';

export async function inputWithInfo({
  message,
  info = 'No additional information available.',
  defaultAnswer,
}: {
  message: string;
  info?: string;
  defaultAnswer?: string;
}): Promise<string> {
  let answer: string = '';
  do {
    answer = await input({
      message: message.concat(` [enter '${INFO_COMMAND}' for more info]`),
      default: defaultAnswer,
    });
    answer = answer.trim().toLowerCase();
    const indentedInfo = indentYamlOrJson(`${info}\n${DOCS_NOTICE}\n`, 4);
    if (answer === INFO_COMMAND) logGray(indentedInfo);
  } while (answer === INFO_COMMAND);
  return answer;
}

/**
 * Gets a {@link WarpCoreConfig} based on the provided path or prompts the user to choose one:
 * - if `symbol` is provided the user will have to select one of the available warp routes.
 * - if `warp` is provided the config will be read by the provided file path.
 * - if none is provided the CLI will exit.
 */
export async function getWarpCoreConfigOrExit({
  context,
  symbol,
  warp,
}: {
  context: CommandContext;
  symbol?: string;
  warp?: string;
}): Promise<WarpCoreConfig> {
  let warpCoreConfig: WarpCoreConfig;
  if (symbol) {
    warpCoreConfig = await selectRegistryWarpRoute(context.registry, symbol);
  } else if (warp) {
    warpCoreConfig = readWarpCoreConfig(warp);
  } else {
    logRed(`Please specify either a symbol or warp config`);
    process.exit(0);
  }

  return warpCoreConfig;
}
