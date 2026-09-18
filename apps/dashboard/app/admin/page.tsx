'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSession } from '../../components/SessionProvider';
import { RequireAuth } from '../../components/RequireAuth';
import { EmptyState } from '../../components/States';
import { EmailCenter } from '../../components/admin/EmailCenter';
import {
  AdminsSection,
  AiSection,
  AuditSection,
  BillingSection,
  ConfigSection,
  DeploymentsSection,
  IncidentsSection,
  InfrastructureSection,
  ObservabilitySection,
  OrganizationsSection,
  OverviewSection,
  ProjectsSection,
  SecuritySection,
  UsersSection,
} from '../../components/admin/Sections';

/**
 * Platform operator console.
 *
 * Every figure here is read from /api/v1/admin, which is staff-gated: the
 * API answers 404 to everyone else, so a developer who guesses the URL sees
 * the same "not found" as a stranger. This page never renders a placeholder
 * number — a platform with one project says one project.
 *
 * Sections the platform cannot answer yet say so, in their own words, rather
 * than showing an empty chart. That is the difference between a console an
 * operator can trust and a wall of decorative cards.
 */

const SECTIONS = [
  { id: 'overview', label: 'Overview', group: 'Platform' },
  { id: 'users', label: 'Users', group: 'Tenants' },
  { id: 'organizations', label: 'Organizations', group: 'Tenants' },
  { id: 'projects', label: 'Projects', group: 'Tenants' },
  { id: 'infrastructure', label: 'Infrastructure', group: 'Operations' },
  { id: 'observability', label: 'Observability', group: 'Operations' },
  { id: 'deployments', label: 'Deployments', group: 'Operations' },
  { id: 'incidents', label: 'Incidents', group: 'Operations' },
  { id: 'security', label: 'Security', group: 'Governance' },
  { id: 'audit', label: 'Audit log', group: 'Governance' },
  { id: 'admins', label: 'Operators', group: 'Governance' },
  { id: 'email', label: 'Email Center', group: 'Communication' },
  { id: 'billing', label: 'Billing', group: 'Commercial' },
  { id: 'ai', label: 'AI', group: 'Commercial' },
  { id: 'config', label: 'Configuration', group: 'System' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function isSectionId(value: string): value is SectionId {
  return SECTIONS.some(s => s.id === value);
}

function groupsOf(): { label: string; items: (typeof SECTIONS)[number][] }[] {
  const out: { label: string; items: (typeof SECTIONS)[number][] }[] = [];
  for (const s of SECTIONS) {
    let bucket = out.find(g => g.label === s.group);
    if (!bucket) {
      bucket = { label: s.group, items: [] };
      out.push(bucket);
    }
    bucket.items.push(s);
  }
  return out;
}

export default function AdminPage(): React.JSX.Element {
  return (
    <RequireAuth>
      <AdminConsole />
    </RequireAuth>
  );
}

function AdminConsole(): React.JSX.Element {
  const { user } = useSession();
  const [section, setSection] = useState<SectionId>('overview');

  /**
   * The section lives in the hash, so an operator can send a colleague a
   * link to Security rather than "open /admin then click Security".
   */
  useEffect(() => {
    const sync = (): void => {
      const raw = window.location.hash.replace('#', '');
      if (isSectionId(raw)) setSection(raw);
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const go = useCallback((id: SectionId) => {
    setSection(id);
    try {
      window.history.replaceState(null, '', `#${id}`);
    } catch {
      // History is unavailable in some embedded contexts; the tab still works.
    }
  }, []);

  if (user && !user.isPlatformAdmin) {
    return (
      <EmptyState
        title="Not available"
        hint="The operator console is limited to CloudNivo staff. Your account is signed in and working normally — this page is simply not yours to see."
      />
    );
  }

  const active = SECTIONS.find(s => s.id === section) ?? SECTIONS[0];

  return (
    <section aria-labelledby="admin-title" className="admin">
      <div className="page-head">
        <div>
          <h1 id="admin-title">{active.label}</h1>
          <p className="sub muted">
            Platform operations · every tenant on this deployment · staff only
          </p>
        </div>
      </div>

      <div className="admin-body">
        <nav className="admin-rail" aria-label="Operator sections">
          {groupsOf().map(g => (
            <div key={g.label} className="admin-rail-group">
              <p className="admin-rail-label">{g.label}</p>
              {g.items.map(s => (
                <button
                  key={s.id}
                  type="button"
                  className="admin-rail-item"
                  aria-current={s.id === section ? 'page' : undefined}
                  onClick={() => go(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="admin-main">
          {section === 'overview' ? <OverviewSection /> : null}
          {section === 'users' ? <UsersSection /> : null}
          {section === 'organizations' ? <OrganizationsSection /> : null}
          {section === 'projects' ? <ProjectsSection /> : null}
          {section === 'infrastructure' ? <InfrastructureSection /> : null}
          {section === 'observability' ? <ObservabilitySection /> : null}
          {section === 'deployments' ? <DeploymentsSection /> : null}
          {section === 'incidents' ? <IncidentsSection /> : null}
          {section === 'security' ? <SecuritySection /> : null}
          {section === 'audit' ? <AuditSection /> : null}
          {section === 'admins' ? <AdminsSection /> : null}
          {section === 'email' ? <EmailCenter /> : null}
          {section === 'billing' ? <BillingSection /> : null}
          {section === 'ai' ? <AiSection /> : null}
          {section === 'config' ? <ConfigSection /> : null}
        </div>
      </div>
    </section>
  );
}
