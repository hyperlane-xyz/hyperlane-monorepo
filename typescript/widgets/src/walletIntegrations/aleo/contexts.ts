import { createContext } from 'react';

export const AleoPopupContext = createContext<{
  showPopUp: boolean;
  setShowPopUp: (show: boolean) => void;
} | null>(null);
