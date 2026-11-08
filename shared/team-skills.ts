export interface TeamSkillPublication {
  id: string;
  revision: string;
  linkId?: string;
  canWithdraw?: boolean;
  canModerate?: boolean;
  version: number;
  name: string;
  description: string;
  content: string;
  updatedAt: string;
  source:
    | {
        origin?: 'team';
        agentId: string;
        agentName: string;
        skillId: string;
        version: number;
      }
    | { origin: 'personal'; version: number };
}

export type PrivateSkillTeamPublication = Pick<
  TeamSkillPublication,
  'id' | 'revision' | 'version' | 'linkId'
> & {
  sourceRevision: string;
};

export interface PrivateSkillPublicationTeam {
  workspaceId: string;
  workspaceName: string;
  publication: PrivateSkillTeamPublication | null;
  policyRevision?: string | null;
}

export interface TeamSkillPublishingPolicy {
  memberPublishing: boolean;
  revision: string;
}

export type TeamSkillSource = Pick<TeamSkillPublication, 'id' | 'revision' | 'version'> & {
  workspaceId?: string;
};

export interface TeamSkillTargetWorkspace {
  workspaceId: string;
  workspaceName: string;
  agents: Array<{ id: string; name: string }>;
}

export interface TeamSkillLink {
  teamId: string;
  publicationId: string;
  linkId: string;
}

const lowerUuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const teamSkillLinkRoute = new RegExp(
  `^/team-skills/(${lowerUuid})/(${lowerUuid})/(${lowerUuid})$`,
);

export function parseTeamSkillLinkPath(path: string): TeamSkillLink | undefined {
  const match = teamSkillLinkRoute.exec(path);
  if (match?.[0] !== path) return;
  return { teamId: match[1], publicationId: match[2], linkId: match[3] };
}

export function teamSkillLinkPath(teamId: string, publicationId: string, linkId?: string) {
  if (!linkId) return;
  const path = `/team-skills/${teamId}/${publicationId}/${linkId}`;
  return parseTeamSkillLinkPath(path) ? path : undefined;
}
