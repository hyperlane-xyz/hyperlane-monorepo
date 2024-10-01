import React, { ComponentType, Key, useMemo, useState } from 'react';

import { deepEquals, isObject, toTitleCase } from '@hyperlane-xyz/utils';

import { ColorPalette } from '../color.js';
import { ArrowIcon } from '../icons/Arrow.js';
import { ChevronIcon } from '../icons/Chevron.js';
import { GearIcon } from '../icons/Gear.js';
import { PencilIcon } from '../icons/Pencil.js';
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
  data: ListItemData[];
  ListComponent: ComponentType<{ data: ListItemData }>;
  onClickItem: (item: ListItemData) => void;
  onClickEditItem: (item: ListItemData) => void;
  searchFn: (args: {
    data: ListItemData[];
    query: string;
    sort: SortState<SortBy>;
    filter: FilterState;
  }) => ListItemData[];
  sortOptions: SortBy[];
  defaultSortState?: SortState<SortBy>;
  FilterComponent: ComponentType<{
    value: FilterState;
    onChange: (s: FilterState) => void;
  }>;
  defaultFilterState: FilterState;
  placeholder?: string;
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

  return (
    <div className="htw-flex htw-flex-col htw-gap-2">
      <div className="htw-relative">
        <SearchBar
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder={placeholder}
        />
        <SearchBarButtons
          isEditMode={isEditMode}
          setIsEditMode={setIsEditMode}
        />
      </div>
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

function SearchBar(props: InputProps) {
  return (
    <div className="htw-relative">
      <SearchIcon
        width={18}
        height={18}
        className="htw-absolute htw-left-4 htw-top-1/2 -htw-translate-y-1/2 htw-opacity-50"
      />
      <TextInput
        {...props}
        className="htw-w-full htw-rounded-lg htw-px-11 htw-py-3"
      />
    </div>
  );
}

function SearchBarButtons({
  isEditMode,
  setIsEditMode: setEditMode,
}: {
  isEditMode: boolean;
  setIsEditMode: (isEditMode: boolean) => void;
}) {
  return (
    <div className="htw-flex htw-items-center htw-gap-4 htw-absolute htw-right-4 htw-top-1/2 -htw-translate-y-1/2">
      <IconButton
        onClick={() => setEditMode(!isEditMode)}
        className="hover:htw-rotate-45"
        title="Chain Settings"
      >
        <GearIcon
          width={20}
          height={20}
          color={isEditMode ? ColorPalette.Blue : undefined}
        />
      </IconButton>
    </div>
  );
}

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
        menuClassname="htw-py-1.5 htw-px-2 htw-flex htw-flex-col htw-gap-2 htw-text-sm"
        menuItems={options.map((o) => (
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
  const filterKeys = useMemo(() => {
    if (!value || !isObject(value)) return [];
    return Object.keys(value).filter(
      (k) => !deepEquals(value[k], defaultValue[k]),
    );
  }, [value]);

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
          <span className="htw-place-self-center htw-px-3">
            {filterKeys.length
              ? filterKeys.map(toTitleCase).join(', ')
              : 'None'}
          </span>
        }
        buttonClassname="htw-h-full htw-flex htw-items-stretch hover:htw-bg-gray-100 active:htw-scale-95"
      >
        <FilterComponent value={value} onChange={onChange} />
      </Popover>
      <IconButton
        disabled={!filterKeys.length}
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
  key: Key;
  data: ListItemData;
  isEditMode: boolean;
  onClickItem: (item: ListItemData) => void;
  onClickEditItem: (item: ListItemData) => void;
  ListComponent: ComponentType<{ data: ListItemData }>;
}

function ListItem<ListItemData extends { disabled?: boolean }>({
  key,
  data,
  isEditMode,
  onClickEditItem,
  onClickItem,
  ListComponent,
}: ListItemProps<ListItemData>) {
  return (
    <button
      className={`-htw-mx-2 htw-px-2.5 htw-py-2.5 htw-rounded htw-grid htw-grid-cols-[1fr,1fr,auto] htw-items-center ${
        data.disabled
          ? 'htw-opacity-50'
          : 'hover:htw-bg-gray-100 active:htw-scale-95'
      } htw-transition-all htw-duration-250`}
      key={key}
      type="button"
      disabled={data.disabled}
      onClick={() => (isEditMode ? onClickEditItem(data) : onClickItem(data))}
    >
      <ListComponent data={data} />
      <div className="htw-justify-self-end">
        {isEditMode ? (
          <PencilIcon width={16} height={16} />
        ) : (
          <ChevronIcon
            direction="e"
            width={15}
            height={20}
            className="htw-opacity-60"
          />
        )}
      </div>
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
