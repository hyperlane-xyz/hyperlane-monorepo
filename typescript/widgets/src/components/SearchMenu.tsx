import React, {
  ChangeEvent,
  ComponentType,
  InputHTMLAttributes,
  useMemo,
  useState,
} from 'react';

import { ColorPalette } from '../color.js';
import { ChevronIcon } from '../icons/Chevron.js';
import { FilterIcon } from '../icons/Filter.js';
import { GearIcon } from '../icons/Gear.js';
import { PencilIcon } from '../icons/Pencil.js';
import { SearchIcon } from '../icons/Search.js';

import { IconButton } from './IconButton.js';

export interface SearchMenuProps<
  ListItem extends { disabled?: boolean },
  SortAndFilterState,
> {
  data: ListItem[];
  searchFn: (
    data: ListItem[],
    query: string,
    filter: SortAndFilterState,
  ) => ListItem[];
  onClickItem: (item: ListItem) => void;
  onClickEditItem: (item: ListItem) => void;
  ListComponent: ComponentType<{ data: ListItem }>;
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
  const [isEditMode, setEditMode] = useState(false);
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
        <SearchInput value={searchQuery} onChange={setSearchQuery} />
        <div className="htw-flex htw-items-center htw-gap-4 htw-absolute htw-right-4 htw-top-1/2 -htw-translate-y-1/2">
          <IconButton onClick={() => setIsFilterOpen(!isFilterOpen)}>
            <FilterIcon
              width={20}
              height={20}
              color={isFilterOpen ? ColorPalette.Blue : undefined}
            />
          </IconButton>
          <IconButton
            onClick={() => setEditMode(!isEditMode)}
            className="hover:htw-rotate-45"
          >
            <GearIcon
              width={20}
              height={20}
              color={isEditMode ? ColorPalette.Blue : undefined}
            />
          </IconButton>
        </div>
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
            <button
              className={`-htw-mx-2 htw-px-2.5 htw-py-2.5 htw-rounded htw-grid htw-grid-cols-[1fr,1fr,auto] htw-items-center ${
                data.disabled
                  ? 'htw-opacity-50'
                  : 'hover:htw-bg-gray-100 active:htw-scale-95'
              } htw-transition-all htw-duration-250`}
              key={i}
              type="button"
              disabled={data.disabled}
              onClick={() =>
                isEditMode ? onClickEditItem(data) : onClickItem(data)
              }
            >
              <ListComponent data={data} />
              <div className="htw-justify-self-end">
                {isEditMode ? (
                  <PencilIcon width={16} height={16} className="" />
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

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> & {
  onChange: (v: string) => void;
  className?: string;
};

function SearchInput({ onChange, className, ...props }: InputProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(e?.target?.value || '');
  };

  return (
    <div className="htw-relative">
      <SearchIcon
        width={18}
        height={18}
        className="htw-absolute htw-left-4 htw-top-1/2 -htw-translate-y-1/2 htw-opacity-50"
      />
      <input
        type="text"
        autoComplete="off"
        onChange={handleChange}
        className={`htw-w-full htw-rounded-full htw-bg-gray-100 htw-px-11 htw-py-3 focus:htw-bg-gray-200 disabled:htw-bg-gray-500 htw-outline-none htw-transition-all htw-duration-300 ${className}`}
        placeholder="Search for chain"
        {...props}
      />
    </div>
  );
}

export enum SortOrderOption {
  Asc = 'asc',
  Desc = 'desc',
}
