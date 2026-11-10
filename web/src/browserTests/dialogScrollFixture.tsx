import '../styles.css';
import '../theme.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeLanguage } from '../i18n';
import { BotTemplateDialog } from '../components/BotTemplateDialog';
import { SettingsDialog } from '../components/SettingsDialog';
import { SkillsDialog } from '../components/SkillsDialog';
import { ComputerDialog } from '../components/ComputerDialog';
import { AccountContext } from '../AccountContext';
import type { AppSettings, Bootstrap, BotAgent, Skill } from '../../../shared/types';

initializeLanguage().setLanguage('en');
const workspaceId = '11111111-1111-4111-8111-111111111111';
const createdAt = '2026-11-07T00:00:00Z';
const scenario = new URLSearchParams(window.location.search);
const workspace = {
  id: workspaceId,
  name: 'Fixture workspace',
  kind: 'personal',
  role: scenario.get('role') === 'member' ? 'member' : 'owner',
  status: 'active',
  createdAt,
} as const;
const user = {
  id: 'fixture-user',
  email: 'computer@example.test',
  name: 'Fixture user',
  status: 'active',
  createdAt,
} as const;
const agent: BotAgent = {
  id: 'fixture-bot',
  name: 'Fixture Bot',
  role: 'Assistant',
  description: '',
  instructions: '',
  color: '#8762c9',
  avatar: 'orb',
  status: 'idle',
};
const skills: Skill[] = Array.from({ length: 14 }, (_, i) => ({
  id: `skill-${i}`,
  agentId: agent.id,
  name: `Synthetic skill ${i + 1}`,
  description: 'A saved reusable workflow for testing the scrollable list.',
  content: 'Review the current request before proceeding.',
  status: 'active',
  version: 1,
  createdAt: '2026-11-07T00:00:00Z',
}));
const settings: AppSettings = {
  profileId: 'fixture',
  profileName: 'Synthetic model',
  provider: 'deepseek',
  model: 'deepseek-flash',
  configured: false,
  hasApiKey: false,
  runtime: 'pi',
  workspace: 'fixture',
  language: 'en',
};
const data: Bootstrap = {
  sync: { epoch: 'fixture', revision: 0 },
  settings,
  agents: [agent],
  conversations: [],
  messages: [],
  memories: [],
  routines: [],
  files: [],
  skills: [],
  computer: {
    connected: !scenario.has('unconnected'),
    name: 'Synthetic computer',
    mode: 'local',
    executionLocation: scenario.has('unconnected') ? 'none' : 'server',
    surface: 'browser',
    platform: 'test',
    status: 'Connected',
    capabilities: [],
    targetRevision: 'fixture-target',
  },
};
const noop = () => {};
function Fixture() {
  const [mode, setMode] = useState('');
  const close = () => setMode('');
  return (
    <>
      {['templates', 'skills', 'settings', 'computer'].map((value) => (
        <button key={value} id={`open-${value}`} onClick={() => setMode(value)}>
          {value}
        </button>
      ))}
      {mode === 'templates' && (
        <BotTemplateDialog
          request={{ kind: 'library' }}
          workspaceId={workspaceId}
          owner
          team={false}
          onClose={close}
          onCreated={noop}
          onChanged={noop}
          onOpenPublic={noop}
        />
      )}
      {mode === 'skills' && (
        <SkillsDialog
          agents={[agent]}
          skills={skills}
          readOnly={false}
          busy={false}
          onClose={close}
          onAdd={async () => ({ ok: true })}
          onTransition={async () => ({ ok: true })}
        />
      )}
      {mode === 'settings' && (
        <SettingsDialog
          workspaceId={workspaceId}
          settings={settings}
          onClose={close}
          onSettingsChanged={noop}
        />
      )}
      {mode === 'computer' && (
        <AccountContext.Provider
          value={{ workspace, session: { authenticated: true, user, workspaces: [workspace] } }}
        >
          <ComputerDialog
            data={data}
            agentId={agent.id}
            conversationId="fixture-chat"
            conversationTitle="Synthetic chat"
            onSelectBot={noop}
            busy={scenario.has('busy')}
            onClose={close}
            onAction={async (work) => {
              await work();
            }}
            refresh={async () => {}}
          />
        </AccountContext.Provider>
      )}
    </>
  );
}
createRoot(document.getElementById('fixture')!).render(<Fixture />);
