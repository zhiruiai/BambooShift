import { uiText } from '../i18n';
import { useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { BotAgent } from '../../../shared/types';
import { GROUP_MIN_MEMBERS, GROUP_MAX_MEMBERS } from '../../../shared/group-members';
import { Avatar } from './Avatar';

export function suggestedGroupTitle(ids: string[], agents: BotAgent[]) {
  const names = ids.map(
    (id) => agents.find((agent) => agent.id === id)?.name || uiText('bots:text_0583e9855b7b'),
  );
  if (!names.length) return '';
  return uiText('bots:text_d616e46bca6d', {
    value0: names.slice(0, 2).join(uiText('common:punct_c4a40ea8fe35')),
    value1: names.length > 2 ? uiText('bots:text_ae0940250474', { value0: names.length }) : '',
  }).slice(0, 100);
}
type Props = {
  agents: BotAgent[];
  ids: string[];
  disabled: boolean;
  onChange: (ids: string[]) => void;
};
export function GroupRecipients(props: Props) {
  const [query, setQuery] = useState('');
  const latest = useRef(props);
  latest.current = props;
  const selected = props.ids.map(
    (id) =>
      props.agents.find((agent) => agent.id === id) || {
        id,
        name: uiText('bots:text_0583e9855b7b'),
      },
  );
  const visible = props.agents.filter((agent) =>
    `${agent.name} ${agent.role}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );
  function select(id: string, checked: boolean) {
    const value = latest.current;
    if (value.disabled) return;
    if (!checked) {
      value.onChange(value.ids.filter((member) => member !== id));
      return;
    }
    if (
      value.ids.includes(id) ||
      value.ids.length >= GROUP_MAX_MEMBERS ||
      !value.agents.some((agent) => agent.id === id)
    )
      return;
    value.onChange([...value.ids, id]);
  }
  return (
    <section className="group-recipients" aria-label={uiText('bots:text_c364178d92ea')}>
      <div className="group-recipient-heading">
        <span className="field-label">{uiText('bots:text_c237b665a6d8')}</span>
        <span>
          {props.ids.length}/{GROUP_MAX_MEMBERS}
          {uiText('bots:text_8bbb19e7903b')}
        </span>
      </div>
      <div className="group-recipient-tags">
        {selected.map((agent, index) => (
          <span className="group-recipient-tag" key={agent.id}>
            <span>
              {agent.name}
              {index === 0 && <small>{uiText('bots:text_a525346277ed')}</small>}
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={uiText('bots:text_28b9e24a18af', { value0: agent.name })}
              disabled={props.disabled}
              onClick={() => select(agent.id, false)}
            >
              <X size={13} />
            </button>
          </span>
        ))}
        {!selected.length && <span className="field-help">{uiText('bots:text_664f631f95bc')}</span>}
      </div>
      <label className="group-recipient-search">
        <Search size={15} />
        <input
          type="search"
          aria-label={uiText('bots:text_346fbe2bc274')}
          placeholder={uiText('bots:text_08bf5195657d')}
          value={query}
          disabled={props.disabled}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="member-picker">
        {visible.map((agent) => (
          <label className="member-choice" key={agent.id}>
            <Avatar agent={agent} size={31} />
            <span>
              {agent.name}
              <small>{agent.role}</small>
            </span>
            <input
              type="checkbox"
              aria-label={uiText('bots:text_97441e895334', { value0: agent.name })}
              checked={props.ids.includes(agent.id)}
              disabled={
                props.disabled ||
                (!props.ids.includes(agent.id) && props.ids.length >= GROUP_MAX_MEMBERS)
              }
              onChange={(event) => select(agent.id, event.target.checked)}
            />
          </label>
        ))}
        {!visible.length && (
          <p className="field-help">
            {props.agents.length
              ? uiText('bots:text_9eff9532d01a')
              : uiText('bots:text_29015d6b3569')}
          </p>
        )}
      </div>
      <p className="field-help" role="status">
        {props.ids.length >= GROUP_MAX_MEMBERS
          ? uiText('bots:text_aa9a55e7d0d1', { value0: GROUP_MAX_MEMBERS })
          : uiText('bots:text_fa070d2a01b4', {
              value0: GROUP_MIN_MEMBERS,
              value1: GROUP_MAX_MEMBERS,
            })}
        {uiText('bots:text_7de580fb4ac5')}
      </p>
    </section>
  );
}
