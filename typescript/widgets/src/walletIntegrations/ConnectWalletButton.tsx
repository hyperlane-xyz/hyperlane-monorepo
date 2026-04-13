import { clsx } from 'clsx';
import React, { ButtonHTMLAttributes } from 'react';

import type { MinimalProviderRegistry } from '@hyperlane-xyz/sdk/providers/MinimalProviderRegistry';
import type { ChainName } from '@hyperlane-xyz/sdk/types';
import { ProtocolType, shortenAddress } from '@hyperlane-xyz/utils';

import { Button } from '../components/Button.js';
import { ChevronIcon } from '../icons/Chevron.js';
import { WalletIcon } from '../icons/Wallet.js';
import { useIsSsr } from '../utils/ssr.js';

import { WalletLogo } from './WalletLogo.js';
import { getAddressFromAccountAndChain } from './accountUtils.js';
import { useAccounts } from './accounts.js';
import type {
  AccountInfo,
  ProtocolWalletDetailsMap,
  WalletDetails,
} from './types.js';
import { useWalletDetails } from './walletDetails.js';

const EMPTY_WALLET_DETAILS: WalletDetails = {};

export type BaseConnectWalletButtonProps = {
  readyAccounts: AccountInfo[];
  walletDetails: ProtocolWalletDetailsMap;
  onClickWhenConnected: () => void;
  onClickWhenUnconnected: () => void;
  countClassName?: string;
  chainName?: ChainName;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export type ConnectWalletButtonProps = {
  multiProvider: MinimalProviderRegistry;
  onClickWhenConnected: () => void;
  onClickWhenUnconnected: () => void;
  countClassName?: string;
  chainName?: ChainName;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function BaseConnectWalletButton({
  readyAccounts,
  walletDetails,
  onClickWhenConnected,
  onClickWhenUnconnected,
  className,
  countClassName,
  chainName,
  ...rest
}: BaseConnectWalletButtonProps) {
  const isSsr = useIsSsr();

  const numReady = readyAccounts.length;
  const firstAccount = readyAccounts[0];

  const shownAddress = shortenAddress(
    getAddressFromAccountAndChain(firstAccount, chainName),
    true,
  );

  const firstWallet =
    (firstAccount && walletDetails[firstAccount.protocol]) ||
    walletDetails[ProtocolType.Ethereum] ||
    EMPTY_WALLET_DETAILS;

  if (isSsr) {
    // https://github.com/wagmi-dev/wagmi/issues/542#issuecomment-1144178142
    return null;
  }

  return (
    <div className="htw-relative">
      <div className="htw-relative">
        {numReady === 0 && (
          <Button
            className={clsx('htw-py-2 htw-px-3', className)}
            onClick={onClickWhenUnconnected}
            title="Choose wallet"
            {...rest}
          >
            <div className="htw-flex htw-items-center htw-gap-2">
              <WalletIcon width={16} height={16} />
              <div className="htw-text-xs sm:htw-text-sm">Connect wallet</div>
            </div>
          </Button>
        )}

        {numReady === 1 && (
          <Button
            onClick={onClickWhenConnected}
            className={clsx('htw-px-2.5 htw-py-1', className)}
            {...rest}
          >
            <div className="htw-flex htw-w-36 htw-items-center htw-justify-center xs:htw-w-auto">
              <WalletLogo walletDetails={firstWallet} size={26} />
              <div className="htw-mx-3 htw-flex htw-flex-col htw-items-start">
                <div className="htw-text-xs htw-text-gray-500">
                  {firstWallet.name || 'Wallet'}
                </div>
                <div className="htw-text-xs">{shownAddress}</div>
              </div>
              <ChevronIcon direction="s" width={10} height={6} />
            </div>
          </Button>
        )}

        {numReady > 1 && (
          <Button
            onClick={onClickWhenConnected}
            className={clsx('htw-px-2.5 htw-py-1', className)}
            {...rest}
          >
            <div className="htw-flex htw-items-center htw-justify-center">
              <div
                style={{ height: 26, width: 26 }}
                className={clsx(
                  'htw-flex htw-items-center htw-justify-center htw-rounded-full htw-bg-gray-600 htw-text-white',
                  countClassName,
                )}
              >
                {numReady}
              </div>
              <div className="htw-mx-3 htw-flex htw-flex-col htw-items-start">
                <div className="htw-text-xs htw-text-gray-500">Wallets</div>
                <div className="htw-text-xs">{`${numReady} Connected`}</div>
              </div>
              <ChevronIcon direction="s" width={10} height={6} />
            </div>
          </Button>
        )}
      </div>
    </div>
  );
}

// Full-matrix convenience wrapper. Selective consumers should use
// BaseConnectWalletButton with protocol-specific hooks and injected state.
export function ConnectWalletButton({
  multiProvider,
  ...props
}: ConnectWalletButtonProps) {
  const { readyAccounts } = useAccounts(multiProvider);
  const walletDetails = useWalletDetails();

  return (
    <BaseConnectWalletButton
      readyAccounts={readyAccounts}
      walletDetails={walletDetails}
      {...props}
    />
  );
}
