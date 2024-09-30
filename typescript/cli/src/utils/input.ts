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
import { KeypressEvent, confirm, input } from '@inquirer/prompts';
import type { PartialDeep } from '@inquirer/type';
import ansiEscapes from 'ansi-escapes';
import chalk from 'chalk';

import { logGray } from '../logger.js';

import { indentYamlOrJson } from './files.js';

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
  helpMode: 'auto',
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
  instructions?: string | boolean;
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
  if (a.name > b.name) {
    return 1;
  } else {
    return -1;
  }
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

export const searchableCheckBox = createPrompt(
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

    const normalizedChoices = normalizeChoices(config.choices);
    const [optionState, setOptionState] = useState<
      SearchableCheckboxState<Value>
    >({
      options: normalizedChoices,
      currentOptionState: Object.fromEntries(
        normalizedChoices.map((item) => [item.name, item]),
      ),
    });

    const [searchTerm, setSearchTerm] = useState<string>('');

    const bounds = useMemo(() => {
      const first = optionState.options.findIndex(isSelectable);
      // findLastIndex replacement as the project must support older ES versions
      let last = -1;
      for (let i = optionState.options.length; i >= 0; --i) {
        if (optionState.options[i] && isSelectable(optionState.options[i])) {
          last = i;
          break;
        }
      }

      return { first, last };
    }, [optionState.options]);

    const [active, setActive] = useState(bounds.first);
    const [showHelpTip, setShowHelpTip] = useState(true);
    const [errorMsg, setError] = useState<string>();

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
        const isValid = await validate([...selection]);
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
      } else if (key.name === 'tab' && optionState.options.length > 0) {
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
          setShowHelpTip(false);
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

    const message = theme.style.message(config.message);

    let description;
    const page = usePagination({
      items: optionState.options,
      active,
      renderItem({ item, isActive }) {
        if (Separator.isSeparator(item)) {
          return ` ${item.separator}`;
        }

        if (item.disabled) {
          const disabledLabel =
            typeof item.disabled === 'string' ? item.disabled : '(disabled)';
          return theme.style.disabledChoice(`${item.name} ${disabledLabel}`);
        }

        if (isActive) {
          description = item.description;
        }

        const checkbox = item.checked
          ? theme.icon.checked
          : theme.icon.unchecked;
        const color = isActive ? theme.style.highlight : (x: string) => x;
        const cursor = isActive ? theme.icon.cursor : ' ';
        return color(`${cursor}${checkbox} ${item.name}`);
      },
      pageSize,
      loop,
    });

    if (status === 'done') {
      const selection = optionState.options.filter(isChecked);
      const answer = theme.style.answer(
        theme.style.renderSelectedChoices(selection, optionState.options),
      );

      return `${prefix} ${message} ${answer}`;
    }

    let helpTipTop = '';
    let helpTipBottom = '';
    if (
      theme.helpMode === 'always' ||
      (theme.helpMode === 'auto' &&
        showHelpTip &&
        (instructions === undefined || instructions))
    ) {
      if (typeof instructions === 'string') {
        helpTipTop = theme.style.helpTip(instructions);
      } else {
        const keys = [
          `${theme.style.key('tab')} to select`,
          `and ${theme.style.key('enter')} to proceed`,
        ];
        helpTipTop = theme.style.helpTip(`(Press ${keys.join(', ')})`);
      }

      if (
        optionState.options.length > pageSize &&
        (theme.helpMode === 'always' ||
          (theme.helpMode === 'auto' && firstRender.current))
      ) {
        helpTipBottom = `\n${theme.style.help(
          '(Use arrow keys to reveal more choices)',
        )}`;
        firstRender.current = false;
      }
    }

    const choiceDescription = description
      ? `\n${theme.style.description(description)}`
      : ``;

    let error = '';
    if (errorMsg) {
      error = `${theme.style.error(errorMsg)}`;
    } else if (
      optionState.options.length === 0 &&
      searchTerm !== '' &&
      status === 'idle'
    ) {
      error = theme.style.error('No results found');
    }

    return `${prefix}${message}${helpTipTop} ${searchTerm}\n${page}${helpTipBottom}${choiceDescription}${error}${ansiEscapes.cursorHide}`;
  },
);
