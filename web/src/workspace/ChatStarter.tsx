import { ArrowUp } from 'lucide-react';
import type { BotAgent } from '../../../shared/types';
import { Avatar } from '../components/Avatar';
import { uiText } from '../i18n';

export function ChatStarter({
  lead,
  choose,
}: {
  lead?: BotAgent;
  choose: (prompt: string) => void;
}) {
  return (
    <div className="empty-conversation">
      <Avatar agent={lead} size={76} />
      <h2>
        {lead
          ? uiText('workspace:text_47c4d56f3453', { value0: lead.name })
          : uiText('workspace:text_deb73cbe990c')}
      </h2>
      <p>{lead?.description || uiText('workspace:text_c892f4226aae')}</p>
      <div className="starter-prompts">
        {[
          uiText('workspace:text_4a7b2a8febae'),
          uiText('workspace:text_418ceb9c923a'),
          uiText('workspace:text_69a9881ceaa9'),
        ].map((prompt) => (
          <button key={prompt} onClick={() => choose(prompt)}>
            {prompt}
            <ArrowUp size={13} />
          </button>
        ))}
      </div>
    </div>
  );
}
