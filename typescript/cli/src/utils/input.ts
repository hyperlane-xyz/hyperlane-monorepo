import {
  Separator,
  type Theme,
  createPrompt,
  isEnterKey,
  makeTheme,
  useEffect,
  useKeypress,
  useMemo,
  usePagination,
  usePrefix,
  useRef,
  useState,
} from '@inquirer/core';
import figures from '@inquirer/figures';
import { KeypressEvent, confirm, input, isSpaceKey } from '@inquirer/prompts';
import type { PartialDeep, Prompt } from '@inquirer/type';
import ansiEscapes from 'ansi-escapes';
import chalk from 'chalk';

import { ProxyAdmin__factory } from '@hyperlane-xyz/core';
import { BaseRegistry } from '@hyperlane-xyz/registry';
import {
  ChainName,
  DeployedOwnableConfig,
  WarpRouteDeployConfig,
} from '@hyperlane-xyz/sdk';
import { isAddress, rootLogger } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { logGray } from '../logger.js';

import { indentYamlOrJson } from './files.js';

export async function detectAndConfirmOrPrompt(
  detect: () => Promise<string | undefined>,
  prompt: string,
  label: string,
  source?: string,
  validate?:
    | ((value: string) => string | boolean | Promise<string | boolean>)
    | undefined,
): Promise<string> {
  let detectedValue: string | undefined;
  try {
    detectedValue = await detect();
    if (detectedValue) {
      const confirmed = await confirm({
        message: `Using ${label} as ${detectedValue}${
          source ? ` from ${source}` : ''
        }, is this correct?`,
      });
      if (confirmed) {
        return detectedValue;
      }
    }
  } catch {
    // Fallback to input prompt
  }
  return input({
    message: `${prompt} ${label}:`,
    default: detectedValue,
    validate,
  });
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
 * Prompts the user to optionally set an existing ProxyAdmin contract address to be used in a WarpToken deployment.
 */
export async function setProxyAdminConfig(
  context: CommandContext,
  chain: ChainName,
): Promise<DeployedOwnableConfig | undefined> {
  let defaultAdminConfig: DeployedOwnableConfig | undefined;

  // default to deploying a new ProxyAdmin with `warpRouteOwner` as the owner
  // if the user supplied the --yes flag
  if (context.skipConfirmation) {
    return defaultAdminConfig;
  }

  const useExistingProxy = await confirm({
    message: `Use an existing Proxy Admin contract for the warp route deployment on chain "${chain}"?`,
  });

  if (!useExistingProxy) {
    return defaultAdminConfig;
  }

  const proxyAdminAddress = await input({
    message: `Please enter the address of the Proxy Admin contract to be used on chain "${chain}":`,
    validate: isAddress,
  });

  const proxy = ProxyAdmin__factory.connect(
    proxyAdminAddress,
    context.multiProvider.getProvider(chain),
  );

  try {
    const ownerAddress = await proxy.owner();
    return {
      address: proxyAdminAddress,
      owner: ownerAddress,
    };
  } catch (error) {
    rootLogger.error(
      `Failed to read owner address from ProxyAdmin contract at ${proxy.address} on chain ${chain}.`,
      error,
    );
    throw new Error(
      `Failed to read owner address from ProxyAdmin contract at ${proxy.address}. Are you sure this is a ProxyAdmin contract?`,
    );
  }
}

export async function getWarpRouteIdFromWarpDeployConfig(
  warpRouteDeployConfig: WarpRouteDeployConfig,
  symbol: string,
): Promise<string> {
  return detectAndConfirmOrPrompt(
    async () =>
      BaseRegistry.warpDeployConfigToId(warpRouteDeployConfig, {
        symbol,
      }),
    'Enter the desired',
    'warp route ID',
    'warp deployment config',
    (warpRouteId) => {
      try {
        return !!BaseRegistry.warpDeployConfigToId(warpRouteDeployConfig, {
          warpRouteId,
        });

        // TODO: Need to also check if warp route id exists
      } catch (e) {
        return (e as Error).toString();
      }
    },
  );
}

/**
 * Searchable checkbox code
 *
 * Note that the code below hab been implemented by taking inspiration from
 * the @inquirer/prompt package search and checkbox prompts
 *
 * - https://github.com/SBoudrias/Inquirer.js/blob/main/packages/search/src/index.mts
 * - https://github.com/SBoudrias/Inquirer.js/blob/main/packages/checkbox/src/index.mts
 */

type Status = 'loading' | 'idle' | 'done';

type SearchableCheckboxTheme = {
  icon: {
    checked: string;
    unchecked: string;
    cursor: string;
  };
  style: {
    disabledChoice: (text: string) => string;
    renderSelectedChoices: <T>(
      selectedChoices: ReadonlyArray<NormalizedChoice<T>>,
      allChoices: ReadonlyArray<NormalizedChoice<T> | Separator>,
    ) => string;
    description: (text: string) => string;
    helpTip: (text: string) => string;
  };
  helpMode: 'always' | 'never' | 'auto';
};

const checkboxTheme: SearchableCheckboxTheme = {
  icon: {
    checked: chalk.green(figures.circleFilled),
    unchecked: figures.circle,
    cursor: figures.pointer,
  },
  style: {
    disabledChoice: (text: string) => chalk.dim(`- ${text}`),
    renderSelectedChoices: (selectedChoices) =>
      selectedChoices.map((choice) => choice.short).join(', '),
    description: (text: string) => chalk.cyan(text),
    helpTip: (text) => ` ${text}`,
  },
  helpMode: 'always',
};

export type SearchableCheckboxChoice<Value> = {
  value: Value;
  name?: string;
  description?: string;
  short?: string;
  disabled?: boolean | string;
  checked?: boolean;
};

type NormalizedChoice<Value> = Required<
  Omit<SearchableCheckboxChoice<Value>, 'description'>
> & {
  description?: string;
};

type SearchableCheckboxConfig<Value> = {
  message: string;
  prefix?: string;
  pageSize?: number;
  instructions?: string;
  choices: ReadonlyArray<SearchableCheckboxChoice<Value>>;
  loop?: boolean;
  required?: boolean;
  selectableOptionsSeparator?: Separator;
  validate?: (
    choices: ReadonlyArray<SearchableCheckboxChoice<Value>>,
  ) => boolean | string | Promise<string | boolean>;
  theme?: PartialDeep<Theme<SearchableCheckboxTheme>>;
};

type Item<Value> = NormalizedChoice<Value> | Separator;

type SearchableCheckboxState<Value> = {
  options: Item<Value>[];
  currentOptionState: Record<string, NormalizedChoice<Value>>;
};

function isSelectable<Value>(
  item: Item<Value>,
): item is NormalizedChoice<Value> {
  return !Separator.isSeparator(item) && !item.disabled;
}

function isChecked<Value>(item: Item<Value>): item is NormalizedChoice<Value> {
  return isSelectable(item) && Boolean(item.checked);
}

function toggle<Value>(item: Item<Value>): Item<Value> {
  return isSelectable(item) ? { ...item, checked: !item.checked } : item;
}

function normalizeChoices<Value>(
  choices: ReadonlyArray<SearchableCheckboxChoice<Value>>,
): NormalizedChoice<Value>[] {
  return choices.map((choice) => {
    const name = choice.name ?? String(choice.value);
    return {
      value: choice.value,
      name,
      short: choice.short ?? name,
      description: choice.description,
      disabled: choice.disabled ?? false,
      checked: choice.checked ?? false,
    };
  });
}

function sortNormalizedItems<Value>(
  a: NormalizedChoice<Value>,
  b: NormalizedChoice<Value>,
): number {
  return a.name.localeCompare(b.name);
}

function organizeItems<Value>(
  items: Array<Item<Value>>,
  selectableOptionsSeparator?: Separator,
): Array<Item<Value> | Separator> {
  const orderedItems = [];

  const checkedItems = items.filter(
    (item) => !Separator.isSeparator(item) && item.checked,
  ) as NormalizedChoice<Value>[];

  if (checkedItems.length !== 0) {
    orderedItems.push(new Separator('--Selected Options--'));

    orderedItems.push(...checkedItems.sort(sortNormalizedItems));
  }

  orderedItems.push(
    selectableOptionsSeparator ?? new Separator('--Available Options--'),
  );

  const nonCheckedItems = items.filter(
    (item) => !Separator.isSeparator(item) && !item.checked,
  ) as NormalizedChoice<Value>[];

  orderedItems.push(...nonCheckedItems.sort(sortNormalizedItems));

  if (orderedItems.length === 1) {
    return [];
  }

  return orderedItems;
}

interface BuildViewOptions<Value> {
  theme: Readonly<Theme<SearchableCheckboxTheme>>;
  pageSize: number;
  firstRender: { current: boolean };
  page: string;
  currentOptions: ReadonlyArray<Item<Value>>;
  prefix: string;
  message: string;
  errorMsg?: string;
  status: Status;
  searchTerm: string;
  description?: string;
  instructions?: string;
}

interface GetErrorMessageOptions
  extends Pick<
    BuildViewOptions<any>,
    'theme' | 'errorMsg' | 'status' | 'searchTerm'
  > {
  currentItemCount: number;
}

function getErrorMessage({
  theme,
  errorMsg,
  currentItemCount,
  status,
  searchTerm,
}: GetErrorMessageOptions): string {
  if (errorMsg) {
    return `${theme.style.error(errorMsg)}`;
  } else if (currentItemCount === 0 && searchTerm !== '' && status === 'idle') {
    return theme.style.error('No results found');
  }

  return '';
}

interface GetHelpTipsOptions
  extends Pick<
    BuildViewOptions<any>,
    'theme' | 'pageSize' | 'firstRender' | 'instructions'
  > {
  currentItemCount: number;
}

function getHelpTips({
  theme,
  instructions,
  currentItemCount,
  pageSize,
  firstRender,
}: GetHelpTipsOptions): { helpTipTop: string; helpTipBottom: string } {
  let helpTipTop = '';
  let helpTipBottom = '';
  const defaultTopHelpTip =
    instructions ??
    `(Press ${theme.style.key('tab')} or ${theme.style.key(
      'space',
    )} to select, and ${theme.style.key('enter')} to proceed`;
  const defaultBottomHelpTip = `\n${theme.style.help(
    '(Use arrow keys to reveal more choices)',
  )}`;

  if (theme.helpMode === 'always') {
    helpTipTop = theme.style.helpTip(defaultTopHelpTip);
    helpTipBottom = currentItemCount > pageSize ? defaultBottomHelpTip : '';
    firstRender.current = false;
  } else if (theme.helpMode === 'auto' && firstRender.current) {
    helpTipTop = theme.style.helpTip(defaultTopHelpTip);
    helpTipBottom = currentItemCount > pageSize ? defaultBottomHelpTip : '';
    firstRender.current = false;
  }

  return { helpTipBottom, helpTipTop };
}

function formatRenderedItem<Value>(
  item: Readonly<Item<Value>>,
  isActive: boolean,
  theme: Readonly<Theme<SearchableCheckboxTheme>>,
): string {
  if (Separator.isSeparator(item)) {
    return ` ${item.separator}`;
  }

  if (item.disabled) {
    const disabledLabel =
      typeof item.disabled === 'string' ? item.disabled : '(disabled)';
    return theme.style.disabledChoice(`${item.name} ${disabledLabel}`);
  }

  const checkbox = item.checked ? theme.icon.checked : theme.icon.unchecked;
  const color = isActive ? theme.style.highlight : (x: string) => x;
  const cursor = isActive ? theme.icon.cursor : ' ';
  return color(`${cursor}${checkbox} ${item.name}`);
}

function getListBounds<Value>(items: ReadonlyArray<Item<Value>>): {
  first: number;
  last: number;
} {
  const first = items.findIndex(isSelectable);
  // findLastIndex replacement as the project must support older ES versions
  let last = -1;
  for (let i = items.length; i >= 0; --i) {
    if (items[i] && isSelectable(items[i])) {
      last = i;
      break;
    }
  }

  return { first, last };
}

function buildView<Value>({
  page,
  prefix,
  theme,
  status,
  message,
  errorMsg,
  pageSize,
  firstRender,
  searchTerm,
  description,
  instructions,
  currentOptions,
}: BuildViewOptions<Value>): string {
  message = theme.style.message(message);
  if (status === 'done') {
    const selection = currentOptions.filter(isChecked);
    const answer = theme.style.answer(
      theme.style.renderSelectedChoices(selection, currentOptions),
    );

    return `${prefix} ${message} ${answer}`;
  }

  const currentItemCount = currentOptions.length;
  const { helpTipBottom, helpTipTop } = getHelpTips({
    theme,
    instructions,
    currentItemCount,
    pageSize,
    firstRender,
  });

  const choiceDescription = description
    ? `\n${theme.style.description(description)}`
    : ``;

  const error = getErrorMessage({
    theme,
    errorMsg,
    currentItemCount,
    status,
    searchTerm,
  });

  return `${prefix} ${message}${helpTipTop} ${searchTerm}\n${page}${helpTipBottom}${choiceDescription}${error}${ansiEscapes.cursorHide}`;
}

// the isUpKey function from the inquirer package is not used
// because it detects k and p as custom keybindings that cause
// the option selection to go up instead of writing the letters
// in the search string
function isUpKey(key: KeypressEvent): boolean {
  return key.name === 'up';
}

// the isDownKey function from the inquirer package is not used
// because it detects j and n as custom keybindings that cause
// the option selection to go down instead of writing the letters
// in the search string
function isDownKey(key: KeypressEvent): boolean {
  return key.name === 'down';
}

export const searchableCheckBox: Prompt<
  any,
  SearchableCheckboxConfig<any>
> = createPrompt(
  <Value>(
    config: SearchableCheckboxConfig<Value>,
    done: (value: Array<Value>) => void,
  ) => {
    const {
      instructions,
      pageSize = 7,
      loop = true,
      required,
      validate = () => true,
      selectableOptionsSeparator,
    } = config;
    const theme = makeTheme<SearchableCheckboxTheme>(
      checkboxTheme,
      config.theme,
    );
    const firstRender = useRef(true);
    const [status, setStatus] = useState<Status>('idle');
    const prefix = usePrefix({ theme });
    const [searchTerm, setSearchTerm] = useState<string>('');
    const [errorMsg, setError] = useState<string>();

    const normalizedChoices = normalizeChoices(config.choices);
    const [optionState, setOptionState] = useState<
      SearchableCheckboxState<Value>
    >({
      options: normalizedChoices,
      currentOptionState: Object.fromEntries(
        normalizedChoices.map((item) => [item.name, item]),
      ),
    });

    const bounds = useMemo(
      () => getListBounds(optionState.options),
      [optionState.options],
    );

    const [active, setActive] = useState(bounds.first);

    useEffect(() => {
      let filteredItems;
      if (!searchTerm) {
        filteredItems = Object.values(optionState.currentOptionState);
      } else {
        filteredItems = Object.values(optionState.currentOptionState).filter(
          (item) =>
            Separator.isSeparator(item) ||
            item.name.includes(searchTerm) ||
            item.checked,
        );
      }

      setActive(0);
      setError(undefined);
      setOptionState({
        currentOptionState: optionState.currentOptionState,
        options: organizeItems(filteredItems, selectableOptionsSeparator),
      });
    }, [searchTerm]);

    useKeypress(async (key, rl) => {
      if (isEnterKey(key)) {
        const selection = optionState.options.filter(isChecked);
        const isValid = await validate(selection);
        if (required && !optionState.options.some(isChecked)) {
          setError('At least one choice must be selected');
        } else if (isValid === true) {
          setStatus('done');
          done(selection.map((choice) => choice.value));
        } else {
          setError(isValid || 'You must select a valid value');
          setSearchTerm('');
        }
      } else if (isUpKey(key) || isDownKey(key)) {
        if (
          loop ||
          (isUpKey(key) && active !== bounds.first) ||
          (isDownKey(key) && active !== bounds.last)
        ) {
          const offset = isUpKey(key) ? -1 : 1;
          let next = active;
          do {
            next =
              (next + offset + optionState.options.length) %
              optionState.options.length;
          } while (
            optionState.options[next] &&
            !isSelectable(optionState.options[next])
          );
          setActive(next);
        }
      } else if (
        (key.name === 'tab' || isSpaceKey(key)) &&
        optionState.options.length > 0
      ) {
        // Avoid the message header to be printed again in the console
        rl.clearLine(0);

        const currentElement = optionState.options[active];
        if (
          currentElement &&
          !Separator.isSeparator(currentElement) &&
          optionState.currentOptionState[currentElement.name]
        ) {
          const updatedDataMap: Record<string, NormalizedChoice<Value>> = {
            ...optionState.currentOptionState,
            [currentElement.name]: toggle(
              optionState.currentOptionState[currentElement.name],
            ) as NormalizedChoice<Value>,
          };

          setError(undefined);
          setOptionState({
            options: organizeItems(
              Object.values(updatedDataMap),
              selectableOptionsSeparator,
            ),
            currentOptionState: updatedDataMap,
          });
          setSearchTerm('');
        }
      } else {
        setSearchTerm(rl.line);
      }
    });

    let description;
    const page = usePagination({
      items: optionState.options,
      active,
      renderItem({ item, isActive }) {
        if (isActive && !Separator.isSeparator(item)) {
          description = item.description;
        }

        return formatRenderedItem(item, isActive, theme);
      },
      pageSize,
      loop,
    });

    return buildView({
      page,
      theme,
      prefix,
      status,
      pageSize,
      errorMsg,
      firstRender,
      searchTerm,
      description,
      instructions,
      currentOptions: optionState.options,
      message: theme.style.message(config.message),
    });
  },
);
