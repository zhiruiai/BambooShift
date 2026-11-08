import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import type { AccountSession, TeamDetails, TeamInvitation } from '../../../../shared/platform';
import '../BotTemplatePage.css';
import '../Platform.css';
import { platformApi } from '../platformApi';
import { TeamDialog } from './parts';
export function useTeamPage({
  workspaceId,
  session,
}: {
  workspaceId: string;
  session?: AccountSession;
}) {
  const [details, setDetails] = useState<TeamDetails | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [dialog, setDialog] = useState<TeamDialog>(null),
    [name, setName] = useState('');
  const [generated, setGenerated] = useState<{ invitation: TeamInvitation; url: string } | null>(
      null,
    ),
    [copied, setCopied] = useState(false),
    [generating, setGenerating] = useState(false);
  const sequence = useRef(0),
    running = useRef(false),
    currentWorkspace = useRef(workspaceId),
    generatedId = useRef<string | undefined>(undefined);
  currentWorkspace.current = workspaceId;
  generatedId.current = generated?.invitation.id;
  const data = details?.workspace.id === workspaceId ? details : null;
  const knownWorkspace = session?.workspaces.find(
    (item) => item.id === workspaceId && item.status === 'active',
  );
  const personal = knownWorkspace?.kind === 'personal';
  const owner = data?.workspace.role === 'owner' && data.workspace.status === 'active';
  const team = data?.workspace.kind === 'team';
  async function load() {
    const id = ++sequence.current;
    const target = workspaceId;
    if (personal) {
      setLoading(false);
      setDetails(null);
      setError('');
      return;
    }
    setLoading(true);
    try {
      const result = await platformApi<TeamDetails>(
        `/account/workspaces/${encodeURIComponent(workspaceId)}/team`,
      );
      if (id === sequence.current && currentWorkspace.current === target) {
        setDetails(result);
        setError('');
      }
    } catch (cause) {
      if (id === sequence.current && currentWorkspace.current === target)
        setError((cause as Error).message);
    } finally {
      if (id === sequence.current && currentWorkspace.current === target) setLoading(false);
    }
  }
  useEffect(() => {
    setDialog(null);
    setGenerated(null);
    setNotice('');
    void load();
    return () => {
      sequence.current++;
    };
  }, [workspaceId, personal]);
  async function work(fn: () => Promise<void>, message?: string) {
    if (running.current) return;
    const target = workspaceId;
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      if (currentWorkspace.current !== target) return;
      await load();
      if (message) setNotice(message);
    } catch (cause) {
      if (currentWorkspace.current === target) setError((cause as Error).message);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const visibleInvitation =
    generated &&
    data?.invitations.find(
      (item) => item.id === generated.invitation.id && item.status === 'pending',
    );
  const unsavedInvitation = !!visibleInvitation && !copied;
  useEffect(() => {
    if (!generating && !unsavedInvitation) return;
    const beforeLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeLeave);
    return () => window.removeEventListener('beforeunload', beforeLeave);
  }, [generating, unsavedInvitation]);
  async function generateInvitation() {
    if (running.current || unsavedInvitation) return;
    setGenerating(true);
    try {
      await work(async () => {
        const result = await platformApi<{ invitation: TeamInvitation; token: string }>(
          `/account/workspaces/${encodeURIComponent(workspaceId)}/invitations`,
          'POST',
          {},
        );
        if (currentWorkspace.current !== workspaceId) return;
        setGenerated({
          invitation: result.invitation,
          url: new URL(`/invite/${encodeURIComponent(result.token)}`, window.location.origin).href,
        });
        setCopied(false);
        setDetails((previous) =>
          previous
            ? {
                ...previous,
                invitations: [
                  result.invitation,
                  ...previous.invitations.filter((item) => item.id !== result.invitation.id),
                ],
              }
            : previous,
        );
      }, uiText('account:text_af5e862070ef'));
    } finally {
      setGenerating(false);
    }
  }

  return {
    generating,
    workspaceId,
    session,
    data,
    knownWorkspace,
    personal,
    owner,
    busy,
    loading,
    load,
    team,
    setName,
    setError,
    setDialog,
    error,
    notice,
    unsavedInvitation,
    generateInvitation,
    generated,
    visibleInvitation,
    setCopied,
    generatedId,
    copied,
    setGenerated,
    setNotice,
    dialog,
    work,
    name,
    currentWorkspace,
  };
}
