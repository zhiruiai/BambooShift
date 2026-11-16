import { useEffect, useRef, useState } from 'react';
import type { ConfirmedBotInstall } from '../../botTemplates';
import { currentLanguage, uiText } from '../../i18n';
import type { Language } from '../../i18n/language';
import { starterBotPacks } from '../../starterSkillPacks';
import type { StarterCategory } from '../../starterTemplates';
import type { Common } from './types';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const activeAttempts = new Map<string, string>();

function requestFor(key: string) {
  try {
    const saved = window.sessionStorage.getItem(key);
    if (saved && uuid.test(saved)) return saved;
  } catch {
    // The live tab can still retry if the browser denies session storage.
  }
  const requestId = activeAttempts.get(key) || crypto.randomUUID();
  activeAttempts.set(key, requestId);
  try {
    window.sessionStorage.setItem(key, requestId);
  } catch {}
  return requestId;
}

function release(key: string, requestId: string) {
  if (activeAttempts.get(key) === requestId) activeAttempts.delete(key);
  try {
    if (window.sessionStorage.getItem(key) === requestId) window.sessionStorage.removeItem(key);
  } catch {}
}

export function verifyStarterBotInstall(
  result: ConfirmedBotInstall | null,
  id: StarterCategory,
  language: Language,
): ConfirmedBotInstall {
  const expected = starterBotPacks(id, language).map((pack) => pack.id);
  if (
    !result ||
    typeof result.agent?.id !== 'string' ||
    !result.agent.id ||
    result.agent.sharedBot ||
    typeof result.conversation?.id !== 'string' ||
    !result.conversation.id ||
    result.conversation.isGroup !== false ||
    !Array.isArray(result.conversation.agentIds) ||
    result.conversation.agentIds.length !== 1 ||
    result.conversation.agentIds[0] !== result.agent.id ||
    !Array.isArray(result.skills) ||
    result.skills.length !== expected.length ||
    new Set(result.skills.map((skill) => skill?.id)).size !== expected.length ||
    expected.some(
      (name) =>
        !result.skills?.some(
          (skill) =>
            skill?.name === name &&
            typeof skill.id === 'string' &&
            !!skill.id &&
            skill.agentId === result.agent.id &&
            skill.skillPackage?.frontmatter.name === name,
        ),
    )
  )
    throw new Error(uiText('workspace:starterInstallFailed'));
  return result;
}

export function useStarterBotInstall(props: Common) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(props);
  latest.current = props;
  const active = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  async function install(id: StarterCategory, language: Language) {
    const { scope, workspaceId, userId } = props;
    const ticket = scope.ticket();
    const current = () => active.current && latest.current.owner && scope.current(ticket);
    if (running.current || !current() || language !== currentLanguage()) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      const key = `openbot-starter-bot-v1:${JSON.stringify([workspaceId, userId, id, language])}`;
      const requestId = requestFor(key);
      const result = verifyStarterBotInstall(
        await scope.request<ConfirmedBotInstall | null>('/starter-bots', 'POST', {
          id,
          language,
          requestId,
        }),
        id,
        language,
      );
      if (!current()) return;
      release(key, requestId);
      latest.current.onCreated(result);
    } catch {
      if (current()) setError(uiText('workspace:starterInstallFailed'));
    } finally {
      running.current = false;
      if (active.current && scope.current(ticket)) setBusy(false);
    }
  }
  return { busy, error, install, clearError: () => setError('') };
}
