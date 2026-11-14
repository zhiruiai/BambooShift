import '../styles.css';
import '../theme.css';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeLanguage } from '../i18n';
import { createAppConnectionScope } from '../appConnections';
import { AgentSettingsContentView } from '../components/agent/AgentSettingsContentView';
import { useAgentSettingsContent } from '../components/agent/useAgentSettingsContent';
import { SkillsDialog } from '../components/SkillsDialog';
import type { BotAgent, Skill } from '../../../shared/types';

export const workspaceId = '11111111-1111-4111-8111-111111111111';
export const userId = '22222222-2222-4222-8222-222222222222';
const firstModel = '33333333-3333-4333-8333-333333333333';
const params = new URLSearchParams(location.search);
initializeLanguage().setLanguage(params.has('zh') ? 'zh-CN' : 'en');
const readOnly = params.has('member');
const initialBot: BotAgent = {
  id: 'bot-a',
  name: 'Synthetic Designer',
  role: 'Build clear interfaces',
  description: 'Synthetic profile for interaction verification.',
  instructions: 'Use reviewed workflows.',
  color: '#45a881',
  avatar: 'orb',
  status: 'idle',
  configRevision: 'revision-a',
  modelProfileId: params.has('missing') ? '99999999-9999-4999-8999-999999999999' : firstModel,
};
function Settings(props: Parameters<typeof useAgentSettingsContent>[0]) {
  return <AgentSettingsContentView {...useAgentSettingsContent(props)} />;
}
function Fixture() {
  const [agent, setAgent] = useState(initialBot);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [mode, setMode] = useState('settings');
  const [scope] = useState(() => createAppConnectionScope({ workspaceId, userId }));
  return mode === 'skills' ? (
    <SkillsDialog
      agents={[agent]}
      skills={skills}
      busy={false}
      readOnly={readOnly}
      onClose={() => setMode('settings')}
      onAdd={async (body) => {
        const skill = await scope.request<Skill>('/skills', 'POST', body);
        setSkills((previous) => [...previous, skill]);
        return { ok: true };
      }}
      onTransition={async (id, action, expectedActiveId) => {
        const skill = await scope.request<Skill>(`/skills/${id}/${action}`, 'POST', {
          expectedActiveId,
        });
        setSkills((previous) => previous.map((item) => (item.id === id ? skill : item)));
        return { ok: true };
      }}
    />
  ) : (
    <Settings
      agent={agent}
      skills={skills}
      skillCount={skills.filter((s) => s.status === 'active').length}
      workspaceId={workspaceId}
      userId={userId}
      workspaceKind="personal"
      computer={{ connected: false } as never}
      readOnly={readOnly}
      busy={false}
      deleteBlocked=""
      fileCount={0}
      boundScreen={false}
      onSkills={() => setMode('skills')}
      onComputer={() => {}}
      onFiles={() => {}}
      onClose={() => {}}
      onDeleted={() => {}}
      onSaved={setAgent}
    />
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
