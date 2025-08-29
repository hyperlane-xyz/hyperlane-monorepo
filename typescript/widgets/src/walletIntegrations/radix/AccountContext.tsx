import React, { createContext, useContext, useState } from 'react';

export type RadixAccount = {
  address: string;
};

interface AccountContextType {
  accounts: RadixAccount[];
  setAccounts: (accounts: RadixAccount[]) => void;
  selectedAccount: string;
  setSelectedAccount: (account: string) => void;
}

const AccountContext = createContext<AccountContextType>({
  accounts: [],
  setAccounts: () => {},
  selectedAccount: '',
  setSelectedAccount: () => {},
});

export function useAccount() {
  return useContext(AccountContext);
}

export const AccountProvider = ({
  children,
}: {
  children: React.ReactNode;
}) => {
  const [accounts, setAccounts] = useState<RadixAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<string>('');

  return (
    <AccountContext.Provider
      value={{ accounts, setAccounts, selectedAccount, setSelectedAccount }}
    >
      {children}
    </AccountContext.Provider>
  );
};
