import { clsx } from 'clsx';
import React, {
  ComponentType,
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { deepEquals, isObject, toTitleCase } from '@hyperlane-xyz/utils';

import { ColorPalette } from '../color.js';
import { ArrowIcon } from '../icons/Arrow.js';
import { PencilIcon } from '../icons/Pencil.js';
import { PlusIcon } from '../icons/Plus.js';
import { SearchIcon } from '../icons/Search.js';
import { XIcon } from '../icons/X.js';
import { DropdownMenu } from '../layout/DropdownMenu.js';
import { Popover } from '../layout/Popover.js';

import { IconButton } from './IconButton.js';
import { InputProps, TextInput } from './TextInput.js';

export interface SearchMenuProps<
  ListItemData extends { disabled?: boolean },
  SortBy extends string,
  FilterState,
> {
  // The list of data items to show
  data: ListItemData[];
  // The component with which the list items will be rendered
  ListComponent: ComponentType<{ data: ListItemData }>;
  // Handler for list item click event
  onClickItem: (item: ListItemData) => void;
  // Handler for edit list item click event
  onClickEditItem: (item: ListItemData) => void;
  // Handler for searching through list item data
  searchFn: (args: {
    data: ListItemData[];
    query: string;
    sort: SortState<SortBy>;
    filter: FilterState;
  }) => ListItemData[];
  // List of sort options
  sortOptions: SortBy[];
  // Default sort state for list data
  defaultSortState?: SortState<SortBy>;
  // The component with which the filter state will be rendered
  FilterComponent: ComponentType<{
    value: FilterState;
    onChange: (s: FilterState) => void;
  }>;
  // Default filter state for list data
  defaultFilterState: FilterState;
  // Placeholder text for the search input
  placeholder?: string;
  // Handler for add button click event
  onClickAddItem?: () => void;
}

export function SearchMenu<
  ListItem extends { disabled?: boolean },
  SortBy extends string,
  FilterState,
>({
  data,
  ListComponent,
  searchFn,
  onClickItem,
  onClickEditItem,
  sortOptions,
  defaultSortState,
  FilterComponent,
  defaultFilterState,
  placeholder,
  onClickAddItem,
}: SearchMenuProps<ListItem, SortBy, FilterState>) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isEditMode, setIsEditMode] = useState(false);
  const [sortState, setSortState] = useState<SortState<SortBy>>(
    defaultSortState || {
      sortBy: sortOptions[0],
      sortOrder: SortOrderOption.Asc,
    },
  );
  const [filterState, setFilterState] =
    useState<FilterState>(defaultFilterState);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(
    () =>
      searchFn({
        data,
        query: searchQuery,
        sort: sortState,
        filter: filterState,
      }),
    [data, searchQuery, sortState, filterState, searchFn],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      e.stopPropagation();
      if (results.length === 1) {
        const item = results[0];
        if (item.disabled) return;
        isEditMode ? onClickEditItem(item) : onClickItem(item);
      }
    },
    [results, isEditMode, onClickEditItem, onClickItem],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="htw-flex htw-flex-col htw-gap-2">
      <form onSubmit={handleSubmit}>
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={placeholder}
          ref={inputRef}
        />
      </form>
      <div className="htw-flex htw-items-center htw-justify-between">
        <div className="htw-flex htw-items-center htw-gap-5">
          <SortDropdown
            options={sortOptions}
            value={sortState}
            onChange={setSortState}
          />
          <FilterDropdown
            value={filterState}
            defaultValue={defaultFilterState}
            onChange={setFilterState}
            FilterComponent={FilterComponent}
          />
        </div>
        <div className="htw-flex htw-items-center htw-gap-3 htw-mr-0.5">
          <IconButton
            onClick={() => setIsEditMode(!isEditMode)}
            className="htw-p-1.5 htw-border htw-border-gray-200 htw-rounded-full"
            title="Edit items"
          >
            <PencilIcon
              width={14}
              height={14}
              color={isEditMode ? ColorPalette.Blue : ColorPalette.Black}
            />
          </IconButton>
          {onClickAddItem && (
            <IconButton
              onClick={onClickAddItem}
              className="htw-p-0.5 htw-border htw-border-gray-200 htw-rounded-full"
              title="Add item"
            >
              <PlusIcon width={22} height={22} />
            </IconButton>
          )}
        </div>
      </div>
      <div className="htw-flex htw-flex-col htw-divide-y htw-divide-gray-100">
        {results.length ? (
          results.map((data, i) => (
            <ListItem
              key={i}
              data={data}
              isEditMode={isEditMode}
              onClickItem={onClickItem}
              onClickEditItem={onClickEditItem}
              ListComponent={ListComponent}
            />
          ))
        ) : (
          <div className="htw-my-8 htw-text-gray-500 htw-text-center">
            No results found
          </div>
        )}
      </div>
    </div>
  );
}

const SearchBar = forwardRef(function SearchBar(
  { onChange, value, ...props }: InputProps,
  ref: React.Ref<HTMLInputElement>,
) {
  return (
    <div className="htw-relative">
      <SearchIcon
        width={18}
        height={18}
        className="htw-absolute htw-left-4 htw-top-1/2 -htw-translate-y-1/2 htw-opacity-50"
      />

      <TextInput
        onChange={onChange}
        value={value}
        ref={ref}
        {...props}
        className="htw-bg-inherit focus:htw-bg-inherit htw-border htw-border-gray-200 focus:htw-border-gray-400 htw-w-full htw-rounded-lg htw-px-11 htw-py-3"
      />
      {value && onChange && (
        <IconButton
          className="htw-absolute htw-right-4 htw-top-1/3 htw-opacity-50"
          onClick={() => onChange('')}
        >
          <XIcon width={14} height={14} />
        </IconButton>
      )}
    </div>
  );
});

function SortDropdown<SortBy extends string>({
  options,
  value,
  onChange,
}: {
  options: SortBy[];
  value: SortState<SortBy>;
  onChange: (v: SortState<SortBy>) => void;
}) {
  const onToggleOrder = () => {
    onChange({
      ...value,
      sortOrder:
        value.sortOrder === SortOrderOption.Asc
          ? SortOrderOption.Desc
          : SortOrderOption.Asc,
    });
  };

  const onSetSortBy = (sortBy: SortBy) => {
    onChange({
      ...value,
      sortBy,
    });
  };

  return (
    <div className="htw-h-7 htw-flex htw-items-stretch htw-text-sm htw-rounded htw-border htw-border-gray-200">
      <div className="htw-flex htw-bg-gray-100 htw-px-2">
        <span className="htw-place-self-center">Sort</span>
      </div>
      <DropdownMenu
        button={
          <span className="htw-place-self-center htw-px-2">
            {toTitleCase(value.sortBy)}
          </span>
        }
        buttonClassname="htw-flex htw-items-stretch hover:htw-bg-gray-100 active:htw-scale-95"
        menuClassname="htw-py-1.5 htw-px-2 htw-flex htw-flex-col htw-gap-2 htw-text-sm htw-border htw-border-gray-100"
        menuItems={options.map((o) => (
          // eslint-disable-next-line react/jsx-key
          <div
            className="htw-rounded htw-p-1.5 hover:htw-bg-gray-200"
            onClick={() => onSetSortBy(o)}
          >
            {toTitleCase(o)}
          </div>
        ))}
        menuProps={{ anchor: 'bottom start' }}
      />
      <IconButton
        onClick={onToggleOrder}
        className="hover:htw-bg-gray-100 active:htw-scale-95 htw-px-0.5 htw-py-1.5"
        title="Toggle sort"
      >
        <ArrowIcon
          direction={value.sortOrder === SortOrderOption.Asc ? 'n' : 's'}
          width={14}
          height={14}
        />
      </IconButton>
    </div>
  );
}

function FilterDropdown<FilterState>({
  value,
  defaultValue,
  onChange,
  FilterComponent,
}: {
  value: FilterState;
  defaultValue: FilterState;
  onChange: (v: FilterState) => void;
  FilterComponent: ComponentType<{
    value: FilterState;
    onChange: (s: FilterState) => void;
  }>;
}) {
  const filterValues = useMemo(() => {
    if (!value || !isObject(value)) return [];
    const modifiedKeys = Object.keys(value).filter(
      (k) => !deepEquals(value[k], defaultValue[k]),
    );
    return modifiedKeys.map((k) => value[k]);
  }, [value, defaultValue]);
  const hasFilters = filterValues.length > 0;

  const onClear = () => {
    onChange(defaultValue);
  };

  return (
    <div className="htw-h-7 htw-flex htw-items-stretch htw-text-sm htw-rounded htw-border htw-border-gray-200">
      <div className="htw-flex htw-bg-gray-100 htw-px-2">
        <span className="htw-place-self-center">Filter</span>
      </div>
      <Popover
        button={
          <span
            className={clsx(
              'htw-place-self-center htw-px-3',
              !hasFilters && 'htw-text-gray-400',
            )}
          >
            {hasFilters ? filterValues.map(toTitleCase).join(', ') : 'None'}
          </span>
        }
        buttonClassname="htw-h-full htw-flex htw-items-stretch hover:htw-bg-gray-100 active:htw-scale-95"
      >
        <FilterComponent value={value} onChange={onChange} />
      </Popover>
      <IconButton
        disabled={!filterValues.length}
        onClick={onClear}
        className="hover:htw-bg-gray-100 active:htw-scale-95 htw-px-1 htw-py-1.5"
        title="Clear filters"
      >
        <XIcon width={9} height={9} />
      </IconButton>
    </div>
  );
}

interface ListItemProps<ListItemData extends { disabled?: boolean }> {
  data: ListItemData;
  isEditMode: boolean;
  onClickItem: (item: ListItemData) => void;
  onClickEditItem: (item: ListItemData) => void;
  ListComponent: ComponentType<{ data: ListItemData }>;
}

function ListItem<ListItemData extends { disabled?: boolean }>({
  data,
  isEditMode,
  onClickEditItem,
  onClickItem,
  ListComponent,
}: ListItemProps<ListItemData>) {
  return (
    <button
      className={clsx(
        '-htw-mx-2 htw-px-2.5 htw-py-2.5 htw-grid htw-grid-cols-[1fr,1fr,auto] htw-items-center htw-relative htw-rounded htw-transition-all htw-duration-250',
        data.disabled
          ? 'htw-opacity-50'
          : 'hover:htw-bg-gray-100 active:htw-scale-95',
      )}
      type="button"
      disabled={data.disabled}
      onClick={() => (isEditMode ? onClickEditItem(data) : onClickItem(data))}
    >
      <ListComponent data={data} />
      {isEditMode && (
        <div className="htw-justify-self-end">
          <PencilIcon width={16} height={16} />
        </div>
      )}
    </button>
  );
}

export interface SortState<SortBy> {
  sortBy: SortBy;
  sortOrder: SortOrderOption;
}

export enum SortOrderOption {
  Asc = 'asc',
  Desc = 'desc',
}
