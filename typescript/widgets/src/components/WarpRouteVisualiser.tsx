import React from 'react';
import { WarpRouteDeployConfig, HypTokenRouterConfig, HyperlaneHookDeployer, HyperlaneIsmDeployer } from '@hyperlane-xyz/sdk';

interface WarpRouteVisualiserProps {
  config: WarpRouteDeployConfig;
}

export function WarpRouteVisualiser({ config }: WarpRouteVisualiserProps) {
  const getTokenAddress = (chainConfig: HypTokenRouterConfig): string | undefined => {
    const tokenTypesWithAddress = [
      'collateral',
      'collateralVault',
      'collateralVaultRebase',
      'collateralFiat',
      'collateralUri',
      'xERC20',
      'xERC20Lockbox',
    ];
    if (tokenTypesWithAddress.includes(chainConfig.type)) {
      return (chainConfig as any).token;
    }
    return undefined;
  };

  const getIsmDetails = (ism: string | HyperlaneIsmDeployer): string => {
    if (typeof ism === 'string') {
      return ism;
    } else if (ism && typeof ism === 'object' && 'type' in ism) {
      return `Type: ${ism.type}`;
    }
    return 'N/A';
  };

  const getHookDetails = (hook: string | HyperlaneHookDeployer): string => {
    if (typeof hook === 'string') {
      return hook;
    } else if (hook && typeof hook === 'object' && 'type' in hook) {
      return `Type: ${hook.type}`;
    }
    return 'N/A';
  };

  return (
    <div className="flex flex-col space-y-6 p-4 bg-gray-50">
      <h1 className="text-2xl font-bold text-gray-800 self-center">Warp Route Configuration</h1>
      {Object.entries(config).map(([chainName, chainConfig]: [string, HypTokenRouterConfig]) => (
        <div key={chainName} className="bg-white shadow-xl rounded-xl p-6 ring-1 ring-gray-200">
          <h2 className="text-xl font-semibold mb-4 text-indigo-600 border-b pb-2">{chainName}</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
            <DetailItem label="Token Type" value={chainConfig.type} />
            <DetailItem label="Token Name" value={chainConfig.name || 'N/A'} />
            <DetailItem label="Token Symbol" value={chainConfig.symbol || 'N/A'} />
            <DetailItem label="Token Decimals" value={chainConfig.decimals?.toString() || 'N/A'} />
            {getTokenAddress(chainConfig) && (
              <DetailItem label="Token Address" value={getTokenAddress(chainConfig)} />
            )}
            <DetailItem label="Owner Address" value={chainConfig.owner} />
            <DetailItem label="Mailbox Address" value={chainConfig.mailbox} />
            {chainConfig.interchainSecurityModule && (
              <DetailItem label="Interchain Security Module" value={getIsmDetails(chainConfig.interchainSecurityModule)} />
            )}
            {chainConfig.hook && (
              <DetailItem label="Hook" value={getHookDetails(chainConfig.hook)} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

interface DetailItemProps {
  label: string;
  value?: string;
}

function DetailItem({ label, value }: DetailItemProps) {
  if (value === undefined || value === null || value.trim() === '') {
    return null;
  }
  return (
    <div className="flex flex-col">
      <span className="text-sm font-medium text-gray-500">{label}</span>
      <span className="text-md text-gray-800 break-all">{value}</span>
    </div>
  );
}
