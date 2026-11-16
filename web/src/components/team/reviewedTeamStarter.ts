import type { BotTeamDraft } from '../../../../shared/bot-team-plans';
type Member = BotTeamDraft['members'][number];

export function matchesTeamStarterMember(
  member: Member,
  saved: Member | undefined,
  allowUniqueName = false,
) {
  if (
    member.kind !== 'create' ||
    saved?.kind !== 'create' ||
    typeof saved.name !== 'string' ||
    typeof saved.color !== 'string' ||
    (saved.avatarImageId ?? null) !== (member.avatarImageId ?? null) ||
    (saved.modelProfileId ?? null) !== (member.modelProfileId ?? null)
  )
    return false;
  const name = member.name.trim();
  const savedName = saved.name.trim();
  // The server adds a numeric suffix when a template name is already in use.
  const suffix =
    allowUniqueName && savedName.startsWith(`${name} `) ? savedName.slice(name.length + 1) : '';
  return (
    (savedName === name || /^(?:[2-9]|[1-9]\d+)$/.test(suffix)) &&
    saved.color.toLowerCase() === member.color.toLowerCase() &&
    (['key', 'role', 'description', 'instructions', 'avatar', 'assignment'] as const).every(
      (field) => typeof saved[field] === 'string' && saved[field].trim() === member[field].trim(),
    )
  );
}

export function matchesReviewedTeamStarter(
  reviewed: BotTeamDraft,
  actual: BotTeamDraft | undefined,
): actual is BotTeamDraft {
  return (
    !!actual &&
    actual.title === reviewed.title &&
    actual.summary === reviewed.summary &&
    actual.leadKey === reviewed.leadKey &&
    Array.isArray(actual.members) &&
    actual.members.length === reviewed.members.length &&
    reviewed.members.every((member, index) =>
      matchesTeamStarterMember(member, actual.members[index], true),
    )
  );
}
