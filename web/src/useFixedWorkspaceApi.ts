import { useEffect, useRef, useState } from 'react';
import { useAccount } from './AccountContext';
import { createChatSendScope } from './chatSendScope';
import { fixedWorkspaceApi } from './fixedWorkspaceApi';
import { currentWorkspaceId } from './workspace-scope';

/** A mounted surface keeps its original actor even if cookies change before React unmounts it. */
export function useFixedWorkspaceApi() {
  const account = useAccount();
  const identity = useRef({
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: account?.session.user?.id,
  });
  identity.current = {
    workspaceId: account?.workspace.id || currentWorkspaceId(),
    userId: account?.session.user?.id,
  };
  const [scope] = useState(() =>
    createChatSendScope({ ...identity.current, identity: () => identity.current }),
  );
  const [api] = useState(() => fixedWorkspaceApi(scope));
  useEffect(() => {
    scope.resume();
    return () => scope.suspend();
  }, [scope]);
  return { api, scope, current: () => scope.current(scope.ticket()) };
}
