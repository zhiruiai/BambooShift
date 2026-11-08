export const TEACHING_LIMITS = {
  steps: 60,
  durationSeconds: 600,
  bytes: 65536,
  note: 1000,
  goal: 2000,
} as const;
export type TeachingStep = {
  id: string;
  action:
    | 'click'
    | 'double_click'
    | 'right_click'
    | 'drag'
    | 'scroll'
    | 'key'
    | 'type'
    | 'navigate'
    | 'back';
  recordedAt: string;
  details?: Record<string, string | number>;
  note: string;
};
export type TeachingSession = {
  id: string;
  revision: string;
  agentId: string;
  conversationId: string;
  status: 'recording' | 'review' | 'interrupted' | 'generating' | 'proposed' | 'error';
  createdAt: string;
  updatedAt: string;
  stoppedAt?: string;
  goal: string;
  steps: TeachingStep[];
  interrupted: boolean;
  reason?: string;
  skillId?: string;
  generationRequestId?: string;
  screen: {
    instanceId: string;
    surface: string;
    screenId?: string;
    revision?: string;
    generation?: string;
  };
};
export type StartTeaching = {
  requestId: string;
  agentId: string;
  conversationId: string;
  leaseId: string;
};
export type ReviewTeaching = {
  expectedRevision: string;
  goal: string;
  steps: { id: string; note: string }[];
};
export type GenerateTeaching = {
  requestId: string;
  expectedRevision: string;
  profileId: string;
  acceptInterrupted?: boolean;
};
