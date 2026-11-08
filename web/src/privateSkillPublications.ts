import type {
  PrivateSkillPublicationTeam,
  PrivateSkillTeamPublication,
} from '../../shared/team-skills';

export type PrivateSkillPublicationIntent = {
  version: 1;
  skillId: string;
  teamId: string;
  requestId: string;
  expectedSourceRevision: string;
  expectedPublicationRevision: string | null;
  expectedTeamPolicyRevision?: string;
};
export type PrivateSkillPublicationResult =
  { publication: PrivateSkillTeamPublication } | { status: 'cancelled' };

const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/.test(value);
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f\d]{64}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function publication(value: unknown): PrivateSkillTeamPublication | undefined {
  if (
    !record(value) ||
    !uuid(value.id) ||
    !uuid(value.revision) ||
    (value.linkId !== undefined && !uuid(value.linkId)) ||
    !digest(value.sourceRevision) ||
    typeof value.version !== 'number' ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1
  )
    return;
  return {
    id: value.id,
    revision: value.revision,
    sourceRevision: value.sourceRevision,
    version: value.version,
    ...(value.linkId === undefined ? {} : { linkId: value.linkId }),
  };
}

export function parsePublicationTeams(value: unknown): PrivateSkillPublicationTeam[] | undefined {
  if (!record(value) || !Array.isArray(value.teams)) return;
  const result: PrivateSkillPublicationTeam[] = [];
  const seen = new Set<string>();
  for (const row of value.teams) {
    if (
      !record(row) ||
      !uuid(row.workspaceId) ||
      seen.has(row.workspaceId) ||
      (row.policyRevision !== undefined &&
        row.policyRevision !== null &&
        !uuid(row.policyRevision)) ||
      typeof row.workspaceName !== 'string' ||
      !row.workspaceName.trim()
    )
      return;
    const item = row.publication === null ? null : publication(row.publication);
    if (item === undefined) return;
    seen.add(row.workspaceId);
    result.push({
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName,
      publication: item,
      ...(row.policyRevision === undefined ? {} : { policyRevision: row.policyRevision }),
    });
  }
  return result;
}

export function parsePublicationResult(
  value: unknown,
  intent: PrivateSkillPublicationIntent,
): PrivateSkillPublicationResult | undefined {
  if (!record(value)) return;
  if (value.status === 'cancelled' && !Object.hasOwn(value, 'publication'))
    return { status: 'cancelled' };
  const item = publication(value.publication);
  if (item?.sourceRevision === intent.expectedSourceRevision) return { publication: item };
}

export function parsePublicationIntent(value: unknown): PrivateSkillPublicationIntent | undefined {
  if (
    !record(value) ||
    Object.keys(value).length !== (value.expectedTeamPolicyRevision === undefined ? 6 : 7) ||
    value.version !== 1 ||
    typeof value.skillId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.skillId) ||
    !uuid(value.teamId) ||
    !uuid(value.requestId) ||
    !digest(value.expectedSourceRevision) ||
    (value.expectedTeamPolicyRevision !== undefined && !uuid(value.expectedTeamPolicyRevision)) ||
    !(value.expectedPublicationRevision === null || uuid(value.expectedPublicationRevision))
  )
    return;
  return {
    version: 1,
    skillId: value.skillId,
    teamId: value.teamId,
    requestId: value.requestId,
    expectedSourceRevision: value.expectedSourceRevision,
    expectedPublicationRevision: value.expectedPublicationRevision,
    ...(value.expectedTeamPolicyRevision === undefined
      ? {}
      : { expectedTeamPolicyRevision: value.expectedTeamPolicyRevision }),
  };
}

export function publicationPath(intent: PrivateSkillPublicationIntent, receipt = false) {
  const root = `/private-skills/${encodeURIComponent(intent.skillId)}/team-publications/${encodeURIComponent(intent.teamId)}`;
  return receipt ? `${root}/${encodeURIComponent(intent.requestId)}` : root;
}

export function publicationRecoveryKey(origin: string, userId: string, workspaceId: string) {
  return `openbot-private-skill-publication-v1:${JSON.stringify([origin, userId, workspaceId])}:`;
}

export function recoverPublicationIntent(storage: Storage, prefix: string) {
  if (!prefix) return;
  let first: PrivateSkillPublicationIntent | undefined;
  let count = 0;
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const raw = storage.getItem(key);
    if (raw === null) continue;
    const intent = raw.length <= 1024 && parsePublicationIntent(JSON.parse(raw));
    if (!intent || key !== prefix + intent.requestId || ++count > 32)
      throw Error('Invalid publication recovery records');
    if (!first || intent.requestId < first.requestId) first = intent;
  }
  return first;
}
