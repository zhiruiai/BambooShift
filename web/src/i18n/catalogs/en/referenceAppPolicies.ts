export default {
  'appPolicies.title': 'Read-only routine authorization',
  'appPolicies.explanation':
    'Allow an enabled saved routine to use one explicitly trusted read-only tool. Chats, manual runs, publisher applications and write operations still require approval.',
  'appPolicies.refresh': 'Check authorizations',
  'appPolicies.unknown':
    'Authorization is unconfirmed. Check the original request, or cancel it to revoke an accepted grant and prevent a late request from taking effect.',
  'appPolicies.cancelUnknown': 'Cancel this authorization',
  'appPolicies.status.active': 'Active',
  'appPolicies.status.invalidated': 'Scope changed; authorize again',
  'appPolicies.status.revoked': 'Revoked',
  'appPolicies.revoke': 'Revoke',
  'appPolicies.routine': 'Saved routine',
  'appPolicies.chooseRoutine': 'Choose a routine',
  'appPolicies.noRoutines': 'Save and enable a routine for a local Bot before authorizing it.',
  'appPolicies.tool': 'Trusted read-only tool',
  'appPolicies.chooseTool': 'Choose an available tool',
  'appPolicies.noTools':
    'This connection has no eligible declared read-only tools. Unknown and write tools still require approval.',
  'appPolicies.arguments': 'Exact arguments (JSON object)',
  'appPolicies.exactScope':
    'Runs automatically only when the tool, arguments and routine configuration match exactly. Different arguments require approval. Editing the routine, connection or tool invalidates the grant. Provider annotations do not prove that a tool is read-only.',
  'appPolicies.confirm':
    'I trust this service and confirm this tool only reads the data specified by these arguments, without writes or other actions.',
  'appPolicies.create': 'Authorize this exact read',
  'appPolicies.argumentsInvalid': 'Enter valid JSON object arguments up to 16 KiB.',
  'appPolicies.storageUnavailable':
    'The recovery identifier cannot be saved, so a new authorization cannot be created. Existing grants are unchanged.',
  'appPolicies.failed': 'The request did not complete. Check its original result.',
  'appPolicies.changed':
    'The routine or application tool has changed. Check the original request, then review the current scope before authorizing again.',
  'appPolicies.closed':
    'This authorization request was cancelled. Check or finish cancelling the original request before starting another.',
  'appPolicies.audit':
    'Authorized by {{owner}} for the exact read-only scope of “{{routine}}”. This card records the actual arguments and result.',
  'appPolicies.you': 'you',
  'appPolicies.owner': 'the workspace owner',
} as const;
