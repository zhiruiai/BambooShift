import { useEffect, useMemo } from 'react';
import { createOperatorScope } from './operatorScope';

export function useOperatorScope(userId: string | undefined) {
  const scope = useMemo(() => createOperatorScope(userId), [userId]);
  useEffect(() => {
    scope.activate();
    return () => scope.suspend();
  }, [scope]);
  return scope;
}
