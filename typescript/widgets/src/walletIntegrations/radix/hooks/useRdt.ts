import { useContext } from 'react';

import { RdtContext } from '../contexts.js';

export const useRdt = () => useContext(RdtContext);
