import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from './types.js';
import {
  isCustomAppConnectionProposal,
  parseAppConnectionProposal,
  sameAppConnectionProposal,
} from './app-proposals.js';

const details = {
  reason: 'Check the documentation tool.',
  runId: 'run-one',
  toolCallId: 'tool-one',
  requester: { userId: 'owner', messageId: 'human-message' },
};
const custom = {
  ...details,
  kind: 'custom_mcp',
  name: 'mcp.example.net',
  url: 'https://mcp.example.net/tools/mcp',
};
const message = (proposal: object): Message => ({
  id: 'app-proposal-card',
  agentId: 'bot-one',
  conversationId: 'personal-chat',
  threadRootId: 'thread-one',
  role: 'assistant',
  kind: 'app_connection_proposal',
  status: 'done',
  content: details.reason,
  metadata: { appConnectionProposal: proposal },
  createdAt: '2026-11-08T05:20:00.000Z',
});

test('app proposal supports both legacy catalogue and exact custom targets', () => {
  const provider = parseAppConnectionProposal(message({ ...details, providerId: 'deepwiki' }));
  assert.equal(isCustomAppConnectionProposal(provider), false);
  assert.equal(provider?.providerId, 'deepwiki');
  const endpoint = parseAppConnectionProposal(message(custom));
  assert.ok(isCustomAppConnectionProposal(endpoint));
  assert.equal(endpoint.url, custom.url);
  assert.equal(endpoint.name, custom.name);
});

test('custom metadata rejects endpoint spoofing, authentication and catalogue aliases', () => {
  for (const proposal of [
    { ...custom, url: custom.url + '?' },
    { ...custom, url: custom.url + '#anchor' },
    { ...custom, url: 'http://mcp.example.net/tools/mcp' },
    { ...custom, url: 'https://user:secret@mcp.example.net/tools/mcp' },
    { ...custom, url: 'https://MCP.example.net/tools/mcp' },
    { ...custom, url: 'https://mcp.example.net:8443/tools/mcp' },
    { ...custom, url: 'https://localhost/mcp', name: 'localhost' },
    { ...custom, url: 'https://mcp.deepwiki.com/mcp/', name: 'mcp.deepwiki.com' },
    { ...custom, name: 'Another service' },
    { ...custom, providerId: 'deepwiki' },
    { ...custom, token: 'synthetic-value' },
  ])
    assert.equal(parseAppConnectionProposal(message(proposal)), undefined);
});

test('opening a custom card binds full path and thread with the immutable requester', () => {
  const card = message(custom);
  assert.ok(sameAppConnectionProposal(card, message({ ...custom })));
  assert.equal(
    sameAppConnectionProposal(card, message({ ...custom, url: custom.url + '/' })),
    false,
  );
  assert.equal(sameAppConnectionProposal(card, { ...card, threadRootId: 'thread-two' }), false);
  assert.equal(
    sameAppConnectionProposal(
      card,
      message({ ...custom, requester: { ...details.requester, userId: 'other' } }),
    ),
    false,
  );
});
