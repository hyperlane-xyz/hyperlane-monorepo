import React, { useCallback, useMemo, useState } from 'react';

import {
  ChainMap,
  ChainMetadata,
  ChainName,
  ChainStatus,
  mergeChainMetadataMap,
} from '@hyperlane-xyz/sdk';
import { ProtocolType, objMap } from '@hyperlane-xyz/utils';

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
  // Replace the default 2nd column (deployer) with custom data
  customListItemField?: CustomListItemField | null;
  // Auto-navigate to a chain details menu
  showChainDetails?: ChainName;
  // Auto-navigate to a chain add menu
  showAddChainMenu?: boolean;
  // Include add button above list
  showAddChainButton?: boolean;
  // Field by which data will be sorted by default
  defaultSortField?: DefaultSortField;
  /**
   * Allow chains to be shown as disabled. Defaults to `false`
   */
  shouldDisableChains?: boolean;
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
  shouldDisableChains = false,
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
    const disabledChainMetadata = getDisabledChains(
      mergedMetadata,
      shouldDisableChains,
    );
    return {
      mergedMetadata: disabledChainMetadata,
      listData: Object.values(disabledChainMetadata),
    };
  }, [chainMetadata, overrideChainMetadata, shouldDisableChains]);

  const { ListComponent, searchFn, sortOptions, defaultSortState } =
    useCustomizedListItems(
      customListItemField,
      shouldDisableChains,
      defaultSortField,
    );

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

function ChainListItem({
  data: chain,
  customField,
}: {
  data: ChainMetadata;
  customField?: CustomListItemField | null;
}) {
  return (
    <>
      <div className="htw-flex htw-items-center">
        <div className="htw-shrink-0">
          <ChainLogo chainName={chain.name} logoUri={chain.logoURI} size={32} />
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
}

function ChainFilters({
  value,
  onChange,
}: {
  value: ChainFilterState;
  onChange: (s: ChainFilterState) => void;
}) {
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
}

function chainSearch({
  data,
  query,
  sort,
  filter,
  customListItemField,
  shouldDisableChains,
}: {
  data: ChainMetadata[];
  query: string;
  sort: SortState<ChainSortByOption>;
  filter: ChainFilterState;
  customListItemField?: CustomListItemField;
  shouldDisableChains?: boolean;
}) {
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
        if (shouldDisableChains) {
          // If one chain is disabled and the other is not, place the disabled chain at the bottom
          const c1Disabled = c1.availability?.status === ChainStatus.Disabled;
          const c2Disabled = c2.availability?.status === ChainStatus.Disabled;
          if (c1Disabled && !c2Disabled) return 1;
          if (!c1Disabled && c2Disabled) return -1;
        }

        // Special case handling for if the chains are being sorted by the
        // custom field provided to ChainSearchMenu
        if (customListItemField && sort.sortBy === customListItemField.header) {
          const result =
            customListItemField.data[c1.name].sortValue -
            customListItemField.data[c2.name].sortValue;
          return sort.sortOrder === SortOrderOption.Asc ? result : -result;
        }

        // Otherwise sort by the default options
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
}

/**
 * This hook creates closures around the provided customListItemField data
 * This is useful because SearchMenu will do handle the list item rendering and
 * management but the custom data is more or a chain-search-specific concern
 */
function useCustomizedListItems(
  customListItemField,
  shouldDisableChains: boolean,
  defaultSortField?: DefaultSortField,
) {
  // Create closure of ChainListItem but with customField pre-bound
  const ListComponent = useCallback(
    ({ data }: { data: ChainMetadata<{ disabled?: boolean }> }) => (
      <ChainListItem data={data} customField={customListItemField} />
    ),
    [customListItemField],
  );

  // Bind the custom field to the search function
  const searchFn = useCallback(
    (args: Parameters<typeof chainSearch>[0]) =>
      chainSearch({ ...args, shouldDisableChains, customListItemField }),
    [customListItemField, shouldDisableChains],
  );

  // Merge the custom field into the sort options if a custom field exists
  const sortOptions = useMemo(
    () => [
      ...(customListItemField ? [customListItemField.header] : []),
      ...Object.values(ChainSortByOption),
    ],
    [customListItemField],
  ) as ChainSortByOption[];

  // Sort by defaultSortField initially, if value is "custom", sort using custom field by default
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

function getDisabledChains(
  chainMetadata: ChainMap<ChainMetadata>,
  shouldDisableChains: boolean,
) {
  if (!shouldDisableChains) return chainMetadata;

  return objMap(chainMetadata, (_, chain) => {
    if (chain.availability?.status === ChainStatus.Disabled) {
      return { ...chain, disabled: true };
    }

    return chain;
  });
}
