import { RadixDappToolkit } from '@radixdlt/radix-dapp-toolkit';
import React from 'react';

import { RdtContext } from './contexts.js';

export const RdtProvider = ({
  value,
  children,
}: {
  value: RadixDappToolkit | null;
  children: React.ReactNode;
}) => <RdtContext.Provider value={value}>{children}</RdtContext.Provider>;
