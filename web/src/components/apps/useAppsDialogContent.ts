import { uiText } from '../../i18n';
import { useEffect, useRef, useState } from 'react';
import type { ConnectedApp, ManagedAppTool } from '../../../../shared/app-connections';
import { ApiError } from '../../api';
import { createAppConnectionScope } from '../../appConnections';
import '../AppsDialog.css';
import { blank, failed, Props } from './parts';
import { appProviders, providerDraft } from '../../appProviders';
import {
  matchesReviewedAddress,
  reviewConnection,
  reviewDraft,
  type CustomAppProposalEntry,
} from '../../appProposalEntry';
import type { ProviderCategory } from './AppProviderCatalog';

const isPersonalOwner = (props: Props) =>
  !!props.workspaceId && !!props.userId && props.canManage && !props.team;

const canManageTools = (props: Props) => !!props.workspaceId && !!props.userId && props.canManage;
type ToolCatalog = { key: string; rows: ManagedAppTool[] };

export function toolAccess(tool?: ManagedAppTool) {
  const value = tool?.access;
  return typeof value?.enabled === 'boolean' &&
    typeof value.revision === 'string' &&
    value.revision.length > 0 &&
    value.revision.length <= 256
    ? value
    : undefined;
}

export function useAppsDialogContent(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const [scope] = useState(() =>
    createAppConnectionScope({ ...props, identity: () => latest.current }),
  );
  const [apps, setApps] = useState<ConnectedApp[]>([]),
    [loading, setLoading] = useState(true);
  const [initialReview] = useState(() => {
    if (!props.canManage) return;
    if (props.initialCustomProposal) return props.team ? undefined : props.initialCustomProposal;
    return appProviders.find((provider) => provider.id === props.initialProviderId);
  });
  const pendingReview = useRef(initialReview);
  const [customReview, setCustomReview] = useState<CustomAppProposalEntry>();
  const [view, setView] = useState<
    'list' | 'review' | 'add' | 'detail' | 'rules' | 'skills' | 'packaged-skills'
  >(initialReview ? 'review' : 'list');
  const [selected, setSelected] = useState(''),
    [search, setSearch] = useState('');
  const [category, setCategory] = useState<ProviderCategory>('all');
  const listScroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (listScroll.current) listScroll.current.scrollTop = 0;
  }, [search, category]);
  const [draft, setDraft] = useState(blank),
    [token, setToken] = useState('');
  const [toolCatalog, setToolCatalog] = useState<ToolCatalog>(),
    [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState(''),
    [toolIssue, setToolIssue] = useState<'changed' | 'uncertain'>(),
    [toolsRead, setToolsRead] = useState(0),
    [toolPolicyEpoch, setToolPolicyEpoch] = useState(0),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [ownBusy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false);
  const [oauthBusy, setOAuthBusy] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const policyBusyRef = useRef(false);
  policyBusyRef.current = policyBusy;
  const oauthBusyRef = useRef(false);
  const busy = ownBusy || oauthBusy || policyBusy;
  const [reauthorize, setReauthorize] = useState(false),
    [confirm, setConfirm] = useState<'disconnect' | 'remove' | null>(null);
  const running = useRef(false),
    readSequence = useRef(0),
    toolSequence = useRef(0),
    writableToolCatalog = useRef<ToolCatalog | undefined>(undefined);
  const uncertainRef = useRef(false);
  const selectedApp = apps.find((app) => app.id === selected);
  const toolKey =
    view === 'detail' && selectedApp?.status === 'connected'
      ? JSON.stringify([selectedApp.id, selectedApp.revision, toolsRead])
      : '';
  const tools = toolCatalog?.key === toolKey ? toolCatalog.rows : [];
  const canEditToolAccess = canManageTools(props) && selectedApp?.toolAccessSupported === true;
  const personalOwner = isPersonalOwner(props);
  const allowed = useRef(props.canManage);
  allowed.current = props.canManage;
  function publishToolCatalog(value: ToolCatalog | undefined) {
    writableToolCatalog.current = value;
    setToolCatalog(value);
  }
  async function refresh() {
    const ticket = scope.ticket();
    if (!scope.current(ticket) || running.current) return;
    const sequence = ++readSequence.current;
    if (view === 'detail') writableToolCatalog.current = undefined;
    setLoading(true);
    try {
      const value = await scope.request<ConnectedApp[]>('/apps');
      if (!scope.current(ticket) || sequence !== readSequence.current) return;
      if (!Array.isArray(value)) throw new ApiError(uiText('apps:text_f2188b437214'), 502);
      setApps(value);
      const target = pendingReview.current;
      if (target && latest.current.canManage) {
        pendingReview.current = undefined;
        const app = reviewConnection(target, value);
        if (app) {
          setSelected(app.id);
          setView('detail');
        } else {
          setDraft(reviewDraft(target) || blank());
          if ('kind' in target) setCustomReview(target);
          setView('add');
        }
      }
      setToolsRead((previous) => previous + 1);
      if (view === 'detail') {
        if (value.find((app) => app.id === selected)?.status !== 'connected')
          setToolIssue(undefined);
        setToolPolicyEpoch((previous) => previous + 1);
      }
      setError('');
      setUncertain(false);
      uncertainRef.current = false;
      if (uncertain) {
        const app = customReview && reviewConnection(customReview, value);
        setView(app ? 'detail' : 'list');
        if (customReview) {
          setCustomReview(undefined);
          setSelected(app?.id || '');
          setDraft(blank());
          if (app) latest.current.onChanged?.();
        }
        setConfirm(null);
        setReauthorize(false);
        setToken('');
        setNotice(uiText('apps:text_bea4c3072362'));
      }
    } catch (cause) {
      if (scope.current(ticket) && sequence === readSequence.current) {
        if (view === 'detail') setToolsError(failed(cause));
        else setError(failed(cause));
      }
    } finally {
      if (scope.current(ticket) && sequence === readSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    scope.resume();
    void refresh();
    return () => {
      scope.suspend();
      readSequence.current++;
      toolSequence.current++;
    };
  }, [scope]);
  useEffect(() => {
    const sequence = ++toolSequence.current,
      ticket = scope.ticket();
    setToolsError('');
    setToolsLoading(false);
    if (!toolKey || !selectedApp) return;
    setToolsLoading(true);
    scope
      .request<ManagedAppTool[]>(`/apps/${encodeURIComponent(selectedApp.id)}/tools`)
      .then((value) => {
        if (!scope.current(ticket) || sequence !== toolSequence.current) return;
        if (!Array.isArray(value)) throw new ApiError(uiText('apps:text_f2188b437214'), 502);
        publishToolCatalog({ key: toolKey, rows: value });
        setToolIssue(undefined);
      })
      .catch((cause) => {
        if (scope.current(ticket) && sequence === toolSequence.current)
          setToolsError(failed(cause));
      })
      .finally(() => {
        if (scope.current(ticket) && sequence === toolSequence.current) setToolsLoading(false);
      });
    return () => {
      toolSequence.current++;
    };
  }, [scope, toolKey]);
  useEffect(() => {
    if (!props.canManage) {
      pendingReview.current = undefined;
      setView((previous) => (previous === 'review' ? 'list' : previous));
      setCustomReview(undefined);
      setToken('');
      setDraft(blank());
      setReauthorize(false);
      setConfirm(null);
    }
  }, [props.canManage]);

  useEffect(() => {
    if ((view === 'rules' || view === 'skills') && !personalOwner) setView('list');
  }, [view, personalOwner]);

  function navigate(next: typeof view, id = '') {
    if (
      running.current ||
      oauthBusyRef.current ||
      policyBusyRef.current ||
      (next === 'packaged-skills' && !scope.current(scope.ticket())) ||
      ((next === 'rules' || next === 'skills') &&
        (!scope.current(scope.ticket()) || !isPersonalOwner(latest.current)))
    )
      return;
    pendingReview.current = undefined;
    if (customReview) {
      setCustomReview(undefined);
      setDraft(blank());
    }
    setView(next);
    setSelected(id);
    setError('');
    setNotice('');
    setToolIssue(undefined);
    publishToolCatalog(undefined);
    setConfirm(null);
    setToken('');
    setReauthorize(false);
  }
  async function changeToolAccess(tool: ManagedAppTool, enabled: boolean) {
    const ticket = scope.ticket();
    const access = toolAccess(tool);
    const catalog = writableToolCatalog.current;
    if (
      !scope.current(ticket) ||
      !canManageTools(latest.current) ||
      !canEditToolAccess ||
      !selectedApp ||
      !toolKey ||
      catalog?.key !== toolKey ||
      !catalog.rows.includes(tool) ||
      !access ||
      access.enabled === enabled ||
      toolIssue ||
      toolsError ||
      toolsLoading ||
      loading ||
      running.current ||
      oauthBusyRef.current ||
      policyBusyRef.current ||
      uncertainRef.current
    )
      return;
    running.current = true;
    writableToolCatalog.current = undefined;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const updated = await scope.request<ManagedAppTool>(
        `/apps/${encodeURIComponent(selectedApp.id)}/tools/access`,
        'PUT',
        {
          toolName: tool.name,
          enabled,
          expectedConnectionRevision: selectedApp.revision,
          expectedToolRevision: access.revision,
        },
      );
      if (!scope.current(ticket) || !canManageTools(latest.current)) return;
      const confirmed = toolAccess(updated);
      if (
        updated?.name !== tool.name ||
        confirmed?.enabled !== enabled ||
        confirmed.revision === access.revision
      ) {
        setToolIssue('uncertain');
        return;
      }
      publishToolCatalog({
        key: toolKey,
        rows: catalog.rows.map((item) => (item === tool ? { ...item, access: confirmed } : item)),
      });
      setToolPolicyEpoch((previous) => previous + 1);
      setNotice(uiText(enabled ? 'apps:toolAccessEnabledNotice' : 'apps:toolAccessDisabledNotice'));
      latest.current.onChanged?.();
    } catch (cause) {
      if (!scope.current(ticket)) return;
      if (cause instanceof ApiError && cause.status === 409) setToolIssue('changed');
      else if (!(cause instanceof ApiError) || cause.status === 0 || cause.status >= 500)
        setToolIssue('uncertain');
      else {
        writableToolCatalog.current = catalog;
        setError(failed(cause));
      }
    } finally {
      running.current = false;
      if (scope.current(ticket)) setBusy(false);
    }
  }
  function selectProvider(id: string) {
    if (
      !scope.current(scope.ticket()) ||
      !allowed.current ||
      running.current ||
      oauthBusyRef.current ||
      policyBusyRef.current ||
      uncertainRef.current
    )
      return;
    const next = providerDraft(id);
    if (!next) return;
    if (draft.name || draft.url || draft.token || draft.shared || draft.authType !== 'none') {
      setError(uiText('workspace:providerDraftRetained'));
      return;
    }
    navigate('add');
    setDraft(next);
  }
  async function mutate(
    work: () => Promise<ConnectedApp | void>,
    success: string,
    removed = false,
  ) {
    const ticket = scope.ticket();
    if (
      !scope.current(ticket) ||
      running.current ||
      oauthBusyRef.current ||
      policyBusyRef.current ||
      !allowed.current ||
      uncertainRef.current
    )
      return;
    running.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    readSequence.current++;
    try {
      const value = await work();
      if (!scope.current(ticket)) return;
      if (removed) {
        setApps((all) => all.filter((app) => app.id !== selected));
        setView('list');
        setSelected('');
      } else if (value) {
        setApps((all) => [...all.filter((app) => app.id !== value.id), value]);
        setSelected(value.id);
        setView('detail');
      }
      setToken('');
      setDraft(blank());
      setCustomReview(undefined);
      setReauthorize(false);
      setConfirm(null);
      setNotice(success);
      props.onChanged?.();
    } catch (cause) {
      if (!scope.current(ticket)) return;
      const reviewedTarget =
        customReview ?? (initialReview && !('kind' in initialReview) ? initialReview : undefined);
      if (
        cause instanceof ApiError &&
        cause.status === 409 &&
        view === 'add' &&
        reviewedTarget &&
        matchesReviewedAddress(reviewedTarget, draft.url)
      ) {
        // Another client may have added this exact endpoint while the form was open.
        const current = await scope.request<ConnectedApp[]>('/apps').catch(() => undefined);
        if (!scope.current(ticket) || !latest.current.canManage) return;
        if (Array.isArray(current)) {
          const app = reviewConnection(reviewedTarget, current);
          if (app) {
            setApps(current);
            setSelected(app.id);
            setView('detail');
            setDraft(blank());
            setCustomReview(undefined);
            setNotice(uiText('workspace:appProposalExisting'));
            if (customReview) latest.current.onChanged?.();
            return;
          }
        }
      }
      setError(failed(cause));
      if (cause instanceof ApiError && (cause.status === 0 || cause.status >= 500)) {
        uncertainRef.current = true;
        setUncertain(true);
      }
    } finally {
      running.current = false;
      if (scope.current(ticket)) {
        setBusy(false);
        setLoading(false);
      }
    }
  }
  const close = () => {
    if (!running.current && !oauthBusyRef.current && !policyBusyRef.current) props.onClose();
  };
  const reconnect = (replaceToken: boolean) => {
    if (!selectedApp || (replaceToken && !token.trim())) return;
    void mutate(
      () =>
        scope.request<ConnectedApp>(
          `/apps/${encodeURIComponent(selectedApp.id)}/reconnect`,
          'POST',
          replaceToken ? { token: token.trim() } : {},
        ),
      uiText('apps:text_ba3cc453d165'),
    );
  };
  const visible = apps.filter((app) =>
    `${app.name} ${app.url}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  return {
    view,
    selectedApp,
    personalOwner,
    props,
    close,
    busy,
    navigate,
    error,
    notice,
    uncertain,
    loading,
    refresh,
    search,
    setSearch,
    category,
    setCategory,
    listScroll,
    apps,
    visible,
    draft,
    customReview,
    setError,
    mutate,
    scope,
    setDraft,
    toolsLoading,
    toolsError,
    tools,
    toolIssue,
    canEditToolAccess,
    changeToolAccess,
    toolPolicyEpoch,
    ownBusy,
    oauthBusyRef,
    setOAuthBusy,
    reconnect,
    confirm,
    setReauthorize,
    reauthorize,
    setToken,
    setConfirm,
    token,
    setPolicyBusy,
    selectProvider,
  };
}
