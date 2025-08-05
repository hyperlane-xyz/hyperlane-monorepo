import { clsx } from 'clsx';
import React, { ButtonHTMLAttributes } from 'react';

import { ChainName, MultiProtocolProvider } from '@hyperlane-xyz/sdk';
import { ProtocolType, objKeys } from '@hyperlane-xyz/utils';

import { Button } from '../components/Button.js';
import { IconButton } from '../components/IconButton.js';
import { LogoutIcon } from '../icons/Logout.js';
import { WalletIcon } from '../icons/Wallet.js';
import { XCircleIcon } from '../icons/XCircle.js';
import { widgetLogger } from '../logger.js';
import { tryClipboardSet } from '../utils/clipboard.js';
import { WalletLogo } from '../walletIntegrations/WalletLogo.js';
import {
  getAddressFromAccountAndChain,
  useAccounts,
  useDisconnectFns,
  useWalletDetails,
} from '../walletIntegrations/multiProtocol.js';

import { AccountInfo, WalletDetails } from './types.js';

const logger = widgetLogger.child({ module: 'walletIntegrations/AccountList' });

export function AccountList({
  multiProvider,
  onClickConnectWallet,
  onCopySuccess,
  className,
  chainName,
}: {
  multiProvider: MultiProtocolProvider;
  onClickConnectWallet: () => void;
  onCopySuccess?: () => void;
  className?: string;
  chainName?: string;
}) {
  const { readyAccounts } = useAccounts(multiProvider);
  const disconnectFns = useDisconnectFns();
  const walletDetails = useWalletDetails();

  const onClickDisconnect = async (protocol: ProtocolType) => {
    try {
      const disconnectFn = disconnectFns[protocol];
      if (disconnectFn) await disconnectFn();
    } catch (error) {
      logger.error('Error disconnecting wallet', error);
    }
  };

  const onClickDisconnectAll = async () => {
    for (const protocol of objKeys(disconnectFns)) {
      await onClickDisconnect(protocol);
    }
  };

  return (
    <div className={clsx('htw-space-y-2', className)}>
      {readyAccounts.map((acc, i) => (
        <AccountSummary
          key={i}
          account={acc}
          walletDetails={walletDetails[acc.protocol]}
          onCopySuccess={onCopySuccess}
          onClickDisconnect={() => onClickDisconnect(acc.protocol)}
          chainName={chainName}
        />
      ))}
      <Button
        onClick={onClickConnectWallet}
        className={clsx(styles.btn, 'htw-py-2 htw-px-2.5')}
      >
        <WalletIcon width={18} height={18} />
        <div className="htw-ml-2 htw-text-sm">Connect wallet</div>
      </Button>
      <Button
        onClick={onClickDisconnectAll}
        className={clsx(styles.btn, 'htw-py-2 htw-px-2.5')}
      >
        <LogoutIcon width={18} height={18} />
        <div className="htw-ml-2 htw-text-sm">Disconnect all wallets</div>
      </Button>
    </div>
  );
}

type AccountSummaryProps = {
  account: AccountInfo;
  walletDetails: WalletDetails;
  onCopySuccess?: () => void;
  onClickDisconnect: () => Promise<void>;
  chainName?: ChainName;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function AccountSummary({
  account,
  onCopySuccess,
  walletDetails,
  onClickDisconnect,
  className,
  chainName,
  ...rest
}: AccountSummaryProps) {
  const address = getAddressFromAccountAndChain(account, chainName);

  const onClickCopy = async () => {
    await tryClipboardSet(address);
    onCopySuccess?.();
  };

  return (
    <div className="htw-relative">
      <Button
        onClick={onClickCopy}
        className={clsx(styles.btn, 'htw-py-2 htw-pl-1 htw-pr-3', className)}
        {...rest}
      >
        <div className="htw-shrink-0 htw-overflow-hidden htw-rounded-full">
          <WalletLogo walletDetails={walletDetails} size={38} />
        </div>
        <div className="htw-mx-3 htw-flex htw-shrink htw-flex-col htw-items-start htw-overflow-hidden">
          <div className="htw-text-sm htw-font-normal htw-text-gray-800">
            {walletDetails.name || 'Wallet'}
          </div>
          <div className="htw-w-full htw-truncate htw-text-left htw-text-xs">
            {address}
          </div>
        </div>
      </Button>
      <div className="htw-absolute htw-right-1 htw-top-1/2 htw--translate-y-1/2 htw-rounded-full">
        <IconButton
          onClick={onClickDisconnect}
          title="Disconnect"
          className="hover:htw-rotate-90"
        >
          <XCircleIcon width={15} height={15} />
        </IconButton>
      </div>
    </div>
  );
}

const styles = {
  btn: 'htw-flex htw-w-full htw-items-center all:htw-justify-start htw-rounded-sm htw-text-sm hover:htw-bg-gray-200 all:hover:htw-opacity-100',
};
