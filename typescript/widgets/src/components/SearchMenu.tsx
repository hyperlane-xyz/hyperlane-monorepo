import React, { ComponentType, Key, useMemo, useState } from 'react';

import { ColorPalette } from '../color.js';
import { ChevronIcon } from '../icons/Chevron.js';
import { FilterIcon } from '../icons/Filter.js';
import { GearIcon } from '../icons/Gear.js';
import { PencilIcon } from '../icons/Pencil.js';
import { SearchIcon } from '../icons/Search.js';

import { IconButton } from './IconButton.js';
import { InputProps, TextInput } from './TextInput.js';

export interface SearchMenuProps<
  ListItemData extends { disabled?: boolean },
  SortAndFilterState,
> {
  data: ListItemData[];
  searchFn: (
    data: ListItemData[],
    query: string,
    filter: SortAndFilterState,
  ) => ListItemData[];
  onClickItem: (item: ListItemData) => void;
  onClickEditItem: (item: ListItemData) => void;
  ListComponent: ComponentType<{ data: ListItemData }>;
  defaultSortAndFilterState: SortAndFilterState;
  FilterComponent: ComponentType<{
    value: SortAndFilterState;
    onChange: (s: SortAndFilterState) => void;
  }>;
}

export function SearchMenu<
  ListItem extends { disabled?: boolean },
  SortAndFilterState,
>({
  data,
  searchFn,
  onClickItem,
  onClickEditItem,
  ListComponent,
  defaultSortAndFilterState,
  FilterComponent,
}: SearchMenuProps<ListItem, SortAndFilterState>) {
  const [searchQuery, setSearchQuery] = useState('');
  const [isEditMode, setIsEditMode] = useState(false);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [filterState, setFilterState] = useState<SortAndFilterState>(
    defaultSortAndFilterState,
  );

  const results = useMemo(
    () => searchFn(data, searchQuery, filterState),
    [data, searchQuery, filterState, searchFn],
  );

  return (
    <div className="htw-flex htw-flex-col">
      <div className="htw-relative">
        <SearchBar value={searchQuery} onChange={setSearchQuery} />
        <SearchBarButtons
          isEditMode={isEditMode}
          isFilterOpen={isFilterOpen}
          setIsEditMode={setIsEditMode}
          setIsFilterOpen={setIsFilterOpen}
        />
      </div>
      <div
        className={`htw-px-4 ${
          isFilterOpen ? 'htw-max-h-28 htw-pt-2 htw-pb-1' : 'htw-max-h-0'
        } htw-overflow-hidden htw-transition-all htw-duration-300`}
      >
        <FilterComponent value={filterState} onChange={setFilterState} />
      </div>

      <div className="htw-mt-2.5 htw-flex htw-flex-col htw-divide-y htw-divide-gray-100">
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
        className="htw-w-full htw-rounded-full htw-px-11 htw-py-3"
      />
    </div>
  );
}

function SearchBarButtons({
  isEditMode,
  isFilterOpen,
  setIsEditMode: setEditMode,
  setIsFilterOpen,
}: {
  isFilterOpen: boolean;
  setIsFilterOpen: (isOpen: boolean) => void;
  isEditMode: boolean;
  setIsEditMode: (isEditMode: boolean) => void;
}) {
  return (
    <div className="htw-flex htw-items-center htw-gap-4 htw-absolute htw-right-4 htw-top-1/2 -htw-translate-y-1/2">
      <IconButton
        onClick={() => setIsFilterOpen(!isFilterOpen)}
        title="Sort & Filter"
      >
        <FilterIcon
          width={20}
          height={20}
          color={isFilterOpen ? ColorPalette.Blue : undefined}
        />
      </IconButton>
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

export enum SortOrderOption {
  Asc = 'asc',
  Desc = 'desc',
}
