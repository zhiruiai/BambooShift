import './ConversationSearch.css';
import { ConversationSearchView } from './search/ConversationSearchView';
import { useConversationSearch } from './search/useConversationSearch';

export function ConversationSearch(props: Parameters<typeof useConversationSearch>[0]) {
  const model = useConversationSearch(props);
  return <ConversationSearchView {...model} />;
}

export default ConversationSearch;
