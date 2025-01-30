import React, { useCallback, useMemo, useState, memo } from 'react';
import { FixedSizeList as List } from 'react-window';
import {
  ChainMap,
  ChainMetadata,
  ChainName,
  mergeChainMetadataMap,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  SearchMenu,
  SortOrderOption,
  SortState,
} from '../components/SearchMenu.js';
import { SegmentedControl } from '../components/SegmentedControl.js';

import { ChainAddMenu } from './ChainAddMenu.js';
import { ChainDetailsMenu } from './ChainDetailsMenu.js';
import { ChainLogo } from './ChainLogo.js';

export enum ChainSortByOption {
  Name = 'name',
  ChainId = 'chain id',
  Protocol = 'protocol',
}

enum FilterTestnetOption {
  Testnet = 'testnet',
  Mainnet = 'mainnet',
}

type DefaultSortField = ChainSortByOption | 'custom';

interface ChainFilterState {
  type?: FilterTestnetOption;
  protocol?: ProtocolType;
}

const defaultFilterState: ChainFilterState = {
  type: undefined,
  protocol: undefined,
};

interface CustomListItemField {
  header: string;
  data: ChainMap<{ display: string; sortValue: number }>;
}

export interface ChainSearchMenuProps {
  chainMetadata: ChainMap<ChainMetadata>;
  overrideChainMetadata?: ChainMap<Partial<ChainMetadata> | undefined>;
  onChangeOverrideMetadata: (
    overrides?: ChainMap<Partial<ChainMetadata> | undefined>,
  ) => void;
  onClickChain: (chain: ChainMetadata) => void;
  customListItemField?: CustomListItemField | null;
  showChainDetails?: ChainName;
  showAddChainMenu?: boolean;
  showAddChainButton?: boolean;
  defaultSortField?: DefaultSortField;
}

export function ChainSearchMenu({
  chainMetadata,
  onChangeOverrideMetadata,
  overrideChainMetadata,
  onClickChain,
  customListItemField,
  showChainDetails,
  showAddChainButton,
  showAddChainMenu,
  defaultSortField,
}: ChainSearchMenuProps) {
  const [drilldownChain, setDrilldownChain] = useState<ChainName | undefined>(
    showChainDetails,
  );
  const [addChain, setAddChain] = useState(showAddChainMenu || false);

  const { listData, mergedMetadata } = useMemo(() => {
    const mergedMetadata = mergeChainMetadataMap(
      chainMetadata,
      overrideChainMetadata,
    );
    return { mergedMetadata, listData: Object.values(mergedMetadata) };
  }, [chainMetadata, overrideChainMetadata]);

  const { ListComponent, searchFn, sortOptions, defaultSortState } =
    useCustomizedListItems(customListItemField, defaultSortField);

  if (drilldownChain && mergedMetadata[drilldownChain]) {
    const isLocalOverrideChain = !chainMetadata[drilldownChain];
    const onRemoveChain = () => {
      const newOverrides = { ...overrideChainMetadata };
      delete newOverrides[drilldownChain];
      onChangeOverrideMetadata(newOverrides);
    };

    return (
      <ChainDetailsMenu
        chainMetadata={chainMetadata[drilldownChain]}
        overrideChainMetadata={overrideChainMetadata?.[drilldownChain]}
        onChangeOverrideMetadata={(o) =>
          onChangeOverrideMetadata({
            ...overrideChainMetadata,
            [drilldownChain]: o,
          })
        }
        onClickBack={() => setDrilldownChain(undefined)}
        onRemoveChain={isLocalOverrideChain ? onRemoveChain : undefined}
      />
    );
  }

  if (addChain) {
    return (
      <ChainAddMenu
        chainMetadata={chainMetadata}
        overrideChainMetadata={overrideChainMetadata}
        onChangeOverrideMetadata={onChangeOverrideMetadata}
        onClickBack={() => setAddChain(false)}
      />
    );
  }

  return (
    <SearchMenu<
      ChainMetadata<{ disabled?: boolean }>,
      ChainSortByOption,
      ChainFilterState
    >
      data={listData}
      ListComponent={ListComponent}
      searchFn={searchFn}
      onClickItem={onClickChain}
      onClickEditItem={(chain) => setDrilldownChain(chain.name)}
      sortOptions={sortOptions}
      defaultSortState={defaultSortState}
      FilterComponent={ChainFilters}
      defaultFilterState={defaultFilterState}
      placeholder="Chain Name or ID"
      onClickAddItem={showAddChainButton ? () => setAddChain(true) : undefined}
    />
  );
}

const ChainListItem = memo(
  ({
    data: chain,
    customField,
  }: {
    data: ChainMetadata;
    customField?: CustomListItemField | null;
  }) => {
    return (
      <>
        <div className="htw-flex htw-items-center">
          <div className="htw-shrink-0">
            <ChainLogo
              chainName={chain.name}
              logoUri={chain.logoURI}
              size={32}
              loading="lazy"
            />
          </div>
          <div className="htw-ml-3 htw-text-left htw-overflow-hidden">
            <div className="htw-text-sm htw-font-medium truncate">
              {chain.displayName}
            </div>
            <div className="htw-text-[0.7rem] htw-text-gray-500">
              {chain.isTestnet ? 'Testnet' : 'Mainnet'}
            </div>
          </div>
        </div>
        {customField !== null && (
          <div className="htw-text-left htw-overflow-hidden">
            <div className="htw-text-sm truncate">
              {customField
                ? customField.data[chain.name].display || 'Unknown'
                : chain.deployer?.name || 'Unknown deployer'}
            </div>
            <div className="htw-text-[0.7rem] htw-text-gray-500">
              {customField ? customField.header : 'Deployer'}
            </div>
          </div>
        )}
      </>
    );
  },
);

const ChainFilters = memo(
  ({
    value,
    onChange,
  }: {
    value: ChainFilterState;
    onChange: (s: ChainFilterState) => void;
  }) => {
    return (
      <div className="htw-py-3 htw-px-2.5 htw-space-y-4">
        <div className="htw-flex htw-flex-col htw-items-start htw-gap-2">
          <label className="htw-text-sm htw-text-gray-600 htw-pl-px">Type</label>
          <SegmentedControl
            options={Object.values(FilterTestnetOption)}
            onChange={(selected) => onChange({ ...value, type: selected })}
            allowEmpty
          />
        </div>
        <div className="htw-flex htw-flex-col htw-items-start htw-gap-2">
          <label className="htw-text-sm htw-text-gray-600 htw-pl-px">
            Protocol
          </label>
          <SegmentedControl
            options={Object.values(ProtocolType)}
            onChange={(selected) => onChange({ ...value, protocol: selected })}
            allowEmpty
          />
        </div>
      </div>
    );
  },
);

const chainSearch = memo(
  ({
    data,
    query,
    sort,
    filter,
    customListItemField,
  }: {
    data: ChainMetadata[];
    query: string;
    sort: SortState<ChainSortByOption>;
    filter: ChainFilterState;
    customListItemField?: CustomListItemField;
  }) => {
    const queryFormatted = query.trim().toLowerCase();
    return (
      data
        // Query search
        .filter(
          (chain) =>
            chain.name.includes(queryFormatted) ||
            chain.displayName?.toLowerCase().includes(queryFormatted) ||
            chain.chainId.toString().includes(queryFormatted) ||
            chain.domainId.toString().includes(queryFormatted),
        )
        // Filter options
        .filter((chain) => {
          let included = true;
          if (filter.type) {
            included &&=
              !!chain.isTestnet === (filter.type === FilterTestnetOption.Testnet);
          }
          if (filter.protocol) {
            included &&= chain.protocol === filter.protocol;
          }
          return included;
        })
        // Sort options
        .sort((c1, c2) => {
          if (customListItemField && sort.sortBy === customListItemField.header) {
            const result =
              customListItemField.data[c1.name].sortValue -
              customListItemField.data[c2.name].sortValue;
            return sort.sortOrder === SortOrderOption.Asc ? result : -result;
          }

          let sortValue1 = c1.name;
          let sortValue2 = c2.name;
          if (sort.sortBy === ChainSortByOption.ChainId) {
            sortValue1 = c1.chainId.toString();
            sortValue2 = c2.chainId.toString();
          } else if (sort.sortBy === ChainSortByOption.Protocol) {
            sortValue1 = c1.protocol;
            sortValue2 = c2.protocol;
          }
          return sort.sortOrder === SortOrderOption.Asc
            ? sortValue1.localeCompare(sortValue2)
            : sortValue2.localeCompare(sortValue1);
        })
    );
  },
);

function useCustomizedListItems(
  customListItemField,
  defaultSortField?: DefaultSortField,
) {
  const ListComponent = useCallback(
    ({ data }: { data: ChainMetadata<{ disabled?: boolean }> }) => (
      <ChainListItem data={data} customField={customListItemField} />
    ),
    [customListItemField],
  );

  const searchFn = useCallback(
    (args: Parameters<typeof chainSearch>[0]) =>
      chainSearch({ ...args, customListItemField }),
    [customListItemField],
  );

  const sortOptions = useMemo(
    () => [
      ...(customListItemField ? [customListItemField.header] : []),
      ...Object.values(ChainSortByOption),
    ],
    [customListItemField],
  ) as ChainSortByOption[];

  const defaultSortState = useMemo(
    () =>
      defaultSortField
        ? {
            sortBy:
              defaultSortField === 'custom' && customListItemField
                ? customListItemField.header
                : defaultSortField,
            sortOrder: SortOrderOption.Desc,
          }
        : undefined,
    [defaultSortField, customListItemField],
  ) as SortState<ChainSortByOption> | undefined;

  return { ListComponent, searchFn, sortOptions, defaultSortState };
}
