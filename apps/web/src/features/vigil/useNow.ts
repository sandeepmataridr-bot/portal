import { useEffect, useState } from 'react';

/** The current time, updated every second, so "N s ago" and no-data states keep moving between polls. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}
