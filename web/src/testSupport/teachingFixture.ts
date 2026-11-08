import { createTeachingClient } from '../teaching';
import type { TeachingSession } from '../../../shared/teaching';
import { json, storage } from './creationFlowFixture';
export const wid = '11111111-1111-4111-8111-111111111111',
  user = '22222222-2222-4222-8222-222222222222';
export const sid = '33333333-3333-4333-8333-333333333333',
  profile = '44444444-4444-4444-8444-444444444444';
export function session(patch: Partial<TeachingSession> = {}): TeachingSession {
  return {
    id: sid,
    revision: crypto.randomUUID(),
    agentId: 'bot-a',
    conversationId: 'chat-a',
    status: 'review',
    createdAt: '2026-11-07T00:00:00Z',
    updatedAt: '2026-11-07T00:00:00Z',
    goal: 'Fill a form',
    interrupted: false,
    screen: { instanceId: crypto.randomUUID(), surface: 'browser' },
    steps: [
      {
        id: crypto.randomUUID(),
        action: 'type',
        recordedAt: '2026-11-07T00:00:00Z',
        details: {},
        note: '',
      },
    ],
    ...patch,
  };
}
export function fixture(
  transport?: (url: string, init: any, fallback: () => Response) => Promise<Response> | Response,
  retained = storage(),
  binding?: () => string | undefined,
) {
  const memory = retained,
    calls: any[] = [],
    states: any[] = [];
  let identity = { userId: user, workspaceId: wid };
  let saved: TeachingSession | undefined;
  const client = createTeachingClient({
    userId: user,
    workspaceId: wid,
    agentId: 'bot-a',
    conversationId: 'chat-a',
    identity: () => identity,
    locationWorkspace: () => identity.workspaceId,
    storage: memory,
    binding,
    onState: (s) => states.push(s),
    fetch: async (url, init) => {
      const path = String(url);
      calls.push({ url: path, ...init });
      const fallback = () => {
        if (path.endsWith('/model-profiles'))
          return json({ profiles: [{ id: profile, name: 'Synthetic model', configured: true }] });
        if (init?.method === 'GET' && path.endsWith('/teaching')) return json(saved ? [saved] : []);
        if (init?.method === 'POST' && path.endsWith('/teaching')) {
          const body = JSON.parse(String(init.body));
          saved = session({ id: body.requestId, status: 'recording' });
          return json(saved);
        }
        return saved ? json(saved) : json({ error: 'missing' }, 404);
      };
      return transport ? transport(path, init, fallback) : fallback();
    },
  });
  return {
    client,
    memory,
    calls,
    states,
    setSaved(value: TeachingSession) {
      saved = value;
    },
    changeActor() {
      identity = { ...identity, userId: 'other-user' };
    },
  };
}
