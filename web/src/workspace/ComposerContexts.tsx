import { X } from 'lucide-react';
import type { ChatAppContext } from '../../../shared/app-connections';
import { isSharedBot } from '../../../shared/shared-bots';
import type { BotAgent, Skill } from '../../../shared/types';
import type { ComposerState } from '../chatDrafts';
import { uiText } from '../i18n';

export function composerSkill(
  draft: ComposerState,
  skills: Skill[] | undefined,
  members: BotAgent[],
) {
  const skill = skills?.find((candidate) => candidate.id === draft.skillId);
  const available =
    skill?.status === 'active' &&
    skill.agentId === draft.agentId &&
    members.some((bot) => bot.id === skill.agentId && !isSharedBot(bot));
  return { skill, skillUnavailable: !!draft.skillId && !available };
}

export function ComposerContexts({
  app,
  appUnavailable,
  selectedSkillId,
  skill,
  skillUnavailable,
  onRemoveApp,
  onRemoveSkill,
}: {
  app?: ChatAppContext;
  appUnavailable: boolean;
  selectedSkillId?: string;
  skill?: Skill;
  skillUnavailable: boolean;
  onRemoveApp: () => void;
  onRemoveSkill: () => void;
}) {
  if (!app && !selectedSkillId) return null;
  return (
    <div className="attachment-tray" role="status">
      {app && (
        <>
          <span title={uiText('workspace:composerAppHelp')}>
            {uiText('workspace:composerAppSelected', { name: app.name })}
            <button
              type="button"
              aria-label={uiText('workspace:composerAppRemove', { name: app.name })}
              onClick={onRemoveApp}
            >
              <X size={13} />
            </button>
          </span>
          {appUnavailable && <small>{uiText('workspace:composerAppUnavailable')}</small>}
        </>
      )}
      {selectedSkillId && (
        <>
          <span title={uiText('workspace:composerSkillHelp')}>
            {skill
              ? uiText('workspace:composerSkillSelected', {
                  name: skill.name,
                  version: skill.version,
                })
              : uiText('workspace:composerSkillSelection')}
            <button
              type="button"
              aria-label={uiText('workspace:composerSkillRemove')}
              onClick={onRemoveSkill}
            >
              <X size={13} />
            </button>
          </span>
          {skillUnavailable && <small>{uiText('workspace:composerSkillUnavailable')}</small>}
        </>
      )}
    </div>
  );
}
