import { useEffect, useState } from 'react';

export function useIsSsr() {
  const [isSsr, setIsSsr] = useState(true);
  // Effects are only run on the client side
  useEffect(() => {
    setIsSsr(false);
  }, []);
  return isSsr;
}
