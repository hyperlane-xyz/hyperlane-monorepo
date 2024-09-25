import {
  Separator,
  type Theme,
  ValidationError,
  createPrompt,
  isDownKey,
  isEnterKey,
  isUpKey,
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
import { confirm, input } from '@inquirer/prompts';
import type { PartialDeep } from '@inquirer/type';
import ansiEscapes from 'ansi-escapes';
import colors from 'yoctocolors-cjs';

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

// TEST

export type Status = 'loading' | 'idle' | 'done';

type CheckboxTheme = {
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
  };
  helpMode: 'always' | 'never' | 'auto';
};

const checkboxTheme: CheckboxTheme = {
  icon: {
    checked: colors.green(figures.circleFilled),
    unchecked: figures.circle,
    cursor: figures.pointer,
  },
  style: {
    disabledChoice: (text: string) => colors.dim(`- ${text}`),
    renderSelectedChoices: (selectedChoices) =>
      selectedChoices.map((choice) => choice.short).join(', '),
    description: (text: string) => colors.cyan(text),
  },
  helpMode: 'auto',
};

type Choice<Value> = {
  value: Value;
  name?: string;
  description?: string;
  short?: string;
  disabled?: boolean | string;
  checked?: boolean;
  type?: never;
};

type NormalizedChoice<Value> = {
  value: Value;
  name: string;
  description?: string;
  short: string;
  disabled: boolean | string;
  checked: boolean;
};

type CheckboxConfig<
  Value,
  ChoicesObject =
    | ReadonlyArray<string | Separator>
    | ReadonlyArray<Choice<Value> | Separator>,
> = {
  message: string;
  prefix?: string;
  pageSize?: number;
  instructions?: string | boolean;
  choices: ChoicesObject extends ReadonlyArray<string | Separator>
    ? ChoicesObject
    : ReadonlyArray<Choice<Value> | Separator>;
  loop?: boolean;
  required?: boolean;
  validate?: (
    choices: ReadonlyArray<Choice<Value>>,
  ) => boolean | string | Promise<string | boolean>;
  theme?: PartialDeep<Theme<CheckboxTheme>>;
};

type Item<Value> = NormalizedChoice<Value> | Separator;

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

// function check(checked: boolean) {
//   return function <Value>(item: Item<Value>): Item<Value> {
//     return isSelectable(item) ? { ...item, checked } : item;
//   };
// }

function normalizeChoices<Value>(
  choices:
    | ReadonlyArray<string | Separator>
    | ReadonlyArray<Choice<Value> | Separator>,
): Item<Value>[] {
  return choices.map((choice) => {
    // @ts-ignore
    if (Separator.isSeparator(choice)) return choice;

    if (typeof choice === 'string') {
      return {
        value: choice as Value,
        name: choice,
        short: choice,
        disabled: false,
        checked: false,
      };
    }

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

// TODO: update this so that it allows user provided separators
function organizeItems<Value>(
  items: Array<Item<Value> | Separator>,
): Array<Item<Value> | Separator> {
  const newitems = [];

  const checkedItems = items.filter(
    (item) => !Separator.isSeparator(item) && item.checked,
  ) as NormalizedChoice<Value>[];

  if (checkedItems.length !== 0) {
    newitems.push(new Separator('--Selected Options--'));

    checkedItems.sort();

    newitems.push(...checkedItems.sort(sortNormalizedItems));
  }

  // TODO: better message
  newitems.push(new Separator('--Available Options--'));

  const nonCheckedItems = items.filter(
    (item) => !Separator.isSeparator(item) && !item.checked,
  ) as NormalizedChoice<Value>[];

  newitems.push(...nonCheckedItems.sort(sortNormalizedItems));

  return newitems;
}

export const searchableCheckBox = <Value>(config: CheckboxConfig<Value>) =>
  createPrompt(
    <Value>(
      config: CheckboxConfig<Value>,
      done: (value: Array<Value>) => void,
    ) => {
      const {
        instructions,
        pageSize = 7,
        loop = true,
        required,
        validate = () => true,
      } = config;
      const theme = makeTheme<CheckboxTheme>(checkboxTheme, config.theme);
      const firstRender = useRef(true);
      const [status, setStatus] = useState<Status>('idle');
      const prefix = usePrefix({ theme });

      const normalizedChoices = normalizeChoices(config.choices);
      const [deps, setDeps] = useState({
        items: normalizedChoices,
        dataMap: Object.fromEntries(
          normalizeChoices(config.choices)
            .filter((item) => !Separator.isSeparator(item))
            .map((item) => [
              (item as NormalizedChoice<Value>).name,
              item as NormalizedChoice<Value>,
            ]),
        ),
      });

      const [searchTerm, setSearchTerm] = useState<string>('');

      const bounds = useMemo(() => {
        const first = deps.items.findIndex(isSelectable);
        // @ts-ignore
        // TODO: add polyfill for this
        const last = deps.items.findLastIndex(isSelectable);

        // TODO: fix this iff there are no items in the list as the cli will throw
        if (first < 0) {
          throw new ValidationError(
            '[checkbox prompt] No selectable choices. All choices are disabled.',
          );
        }

        return { first, last };
      }, [deps]);

      const [active, setActive] = useState(bounds.first);
      const [showHelpTip, setShowHelpTip] = useState(true);
      const [errorMsg, setError] = useState<string>();

      useEffect(() => {
        const controller = new AbortController();

        setStatus('loading');
        setError(undefined);

        const fetchResults = async () => {
          try {
            let filteredItems;
            if (!searchTerm) {
              filteredItems = Object.values(deps.dataMap);
            } else {
              filteredItems = Object.values(deps.dataMap).filter(
                (item) =>
                  Separator.isSeparator(item) ||
                  item.name.includes(searchTerm) ||
                  item.checked,
              );
            }

            if (!controller.signal.aborted) {
              // Reset the pointer
              setActive(bounds.first);
              setError(undefined);
              // setItems(organizeItems(filteredItems));
              setDeps({
                items: organizeItems(filteredItems),
                dataMap: deps.dataMap,
              });
              setStatus('idle');
            }
          } catch (error: unknown) {
            if (!controller.signal.aborted && error instanceof Error) {
              setError(error.message);
            }
          }
        };

        void fetchResults();

        return () => {
          controller.abort();
        };
      }, [searchTerm]);

      useKeypress(async (key, rl) => {
        if (isEnterKey(key)) {
          const selection = deps.items.filter(isChecked);
          const isValid = await validate([...selection]);
          if (required && !deps.items.some(isChecked)) {
            setError('At least one choice must be selected');
          } else if (isValid === true) {
            setStatus('done');
            done(selection.map((choice) => choice.value));
          } else {
            setError(isValid || 'You must select a valid value');
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
              next = (next + offset + deps.items.length) % deps.items.length;
            } while (!isSelectable(deps.items[next]!));
            setActive(next);
          }
        } else if (key.name === 'tab') {
          // Avoid the header to be printed again in the console
          rl.clearLine(0);
          setError(undefined);
          setShowHelpTip(false);

          const currentElement = deps.items[active];
          if (
            currentElement &&
            !Separator.isSeparator(currentElement) &&
            deps.dataMap[currentElement.name]
          ) {
            const dataMap: Record<string, NormalizedChoice<Value>> = {
              ...deps.dataMap,
              [currentElement.name]: toggle(
                deps.dataMap[currentElement.name],
              ) as NormalizedChoice<Value>,
            };

            setDeps({ items: organizeItems(Object.values(dataMap)), dataMap });
          }

          setSearchTerm('');
        } else {
          setSearchTerm(rl.line);
        }
      });

      const message = theme.style.message(config.message);

      let description;
      const page = usePagination({
        items: deps.items,
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
        const selection = deps.items.filter(isChecked);
        const answer = theme.style.answer(
          theme.style.renderSelectedChoices(selection, deps.items),
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
          helpTipTop = instructions;
        } else {
          const keys = [
            `${theme.style.key('space')} to select`,
            `${theme.style.key('a')} to toggle all`,
            `${theme.style.key('i')} to invert selection`,
            `and ${theme.style.key('enter')} to proceed`,
          ];
          helpTipTop = ` (Press ${keys.join(', ')})`;
        }

        if (
          deps.items.length > pageSize &&
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
        error = `\n${theme.style.error(errorMsg)}`;
      }

      return `${prefix}${message}${helpTipTop} ${
        searchTerm ?? ''
      }\n${page}${helpTipBottom}${choiceDescription}${error}${
        ansiEscapes.cursorHide
      }`;
    },
  )(config);
