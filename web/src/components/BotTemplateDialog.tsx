import { uiText } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { createBotTemplateScope } from '../botTemplates';
import './BotTemplates.css';
import { TemplateLibrary } from './templates/TemplateLibrary';
import { TemplateManager } from './templates/TemplateManager';
import { TemplateSource } from './templates/TemplateSource';
import { Props } from './templates/types';
import { Dialog } from './UI';
export type { BotTemplateDialogRequest } from './templates/types';
export function BotTemplateDialog(props: Props) {
  const [view, setView] = useState(props.request);
  const latest = useRef(props);
  latest.current = props;
  const [scope] = useState(() =>
    createBotTemplateScope({ ...props, identity: () => latest.current }),
  );
  useEffect(() => {
    scope.resume();
    return () => scope.suspend();
  }, [scope]);
  const current = () => scope.current(scope.ticket());
  const common = {
    ...props,
    scope,
    onBack: () => {
      if (current()) setView({ kind: 'library' });
    },
    onManage: (templateId: string) => {
      if (current()) setView({ kind: 'manage', templateId });
    },
  };
  if (view.kind === 'library') return <TemplateLibrary {...common} />;
  if (!props.owner)
    return (
      <Dialog title={uiText('bots:text_0f77795ac6f1')} onClose={props.onClose}>
        <p className="field-help">{uiText('bots:text_ba429d1b7f17')}</p>
      </Dialog>
    );
  if (view.kind === 'manage')
    return <TemplateManager key={view.templateId} {...common} templateId={view.templateId} />;
  return <TemplateSource key={`${view.kind}:${view.agentId}`} {...common} request={view} />;
}
