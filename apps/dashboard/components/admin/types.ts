import type { GrowthPoint } from '../GrowthChart';

/** Shapes returned by /api/v1/admin. Kept in one place so sections agree. */

export interface Overview {
  totals: { users: number; organizations: number; projects: number; databases: number };
  recent: {
    usersThisWeek: number;
    usersThisMonth: number;
    projectsThisWeek: number;
    projectsThisMonth: number;
  };
  growth: GrowthPoint[];
  databases: Record<string, number>;
  provisioning: { failed: number };
  trafficSinceBoot: {
    requests: number;
    errors: number;
    errorRate: number;
    p50Ms: number;
    p95Ms: number;
    since: string;
  };
  generatedAt: string;
}

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  members: number;
  projects: number;
}

export interface OrgDetail extends OrgRow {
  createdAt: string;
  memberList: { userId: string; email: string | null; role: string }[];
  projectList: { id: string; name: string; slug: string; region: string }[];
}

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  organizationId: string;
  organizationName: string | null;
  region: string;
  databaseStatus: string | null;
  createdAt: string;
}

export interface ProjectDetail extends ProjectRow {
  slugPath: string;
  databaseHealth: string | null;
  ownerEmail: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  isPlatformAdmin: boolean;
  createdAt: string;
  suspendedAt: string | null;
}

export interface UserDetail extends UserRow {
  totpEnabled: boolean;
  organizations: { id: string; name: string; slug: string; role: string }[];
  projects: { id: string; name: string; organizationId: string }[];
}

export interface JobRow {
  id: string;
  projectId: string;
  organizationId?: string;
  kind: string;
  status?: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  updatedAt: string;
}

export interface AuditRow {
  id: string;
  action: string;
  organizationId: string | null;
  actorUserId: string | null;
  createdAt: string;
}

export interface SecurityView {
  events: AuditRow[];
  failedLogins: number;
  suspendedLoginAttempts: number;
  staffCount: number;
  posture: {
    captchaConfigured: boolean;
    emailDriver: string;
    controlStore: string;
    trustedProxyHops: number;
  };
}

export interface ObservabilityView {
  scope: string;
  since: string;
  windowMs: number;
  requests: number;
  errors: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
  byService: {
    service: string;
    requests: number;
    errors: number;
    errorRate: number;
    p50Ms: number;
    p95Ms: number;
  }[];
  topRoutes: { method: string; route: string; requests: number; errors: number }[];
  timeline: { at: number; requests: number; errors: number }[];
}

export interface InfrastructureView {
  components: Record<string, { ok: boolean; detail: string | null }>;
  databases: Record<string, number>;
  failedJobs: JobRow[];
  drivers: Record<string, string>;
}

export interface ConfigView {
  environment: string;
  appUrl: string;
  drivers: Record<string, string>;
  configured: Record<string, boolean>;
  senderAddress: string | null;
  migrateOnBoot: boolean;
  trustedProxyHops: number;
}

export interface AdminsView {
  admins: UserRow[];
  actions: AuditRow[];
}

export type EmailStatus = 'draft' | 'queued' | 'sent' | 'failed' | 'bounced' | 'complained';

export interface EmailRow {
  id: string;
  actorUserId: string | null;
  actorEmail: string;
  recipients: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  template: string | null;
  status: EmailStatus;
  provider: string | null;
  providerId: string | null;
  error: string | null;
  isTest: boolean;
  sentAt: string | null;
  createdAt: string;
}

export interface EmailsView {
  emails: EmailRow[];
  counts: Record<string, number>;
  sender: { driver: string; from: string | null; ready: boolean };
}

export interface EmailTemplate {
  id: string;
  name: string;
  description: string;
  subject: string;
  intro: string;
  bullets: string[];
  closing: string;
  cta: { label: string; path: string } | null;
}
