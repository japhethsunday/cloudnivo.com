'use client';

import { use } from 'react';
import { AutomationPanel } from '../../../../components/AutomationPanel';

export default function ProjectAutomationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  return (
    <div>
      <div className="section-head">
        <p className="eyebrow">Project</p>
        <h2>Automations</h2>
        <p>
          Queues buffer work, schedules invoke functions on a cron timetable, and webhooks deliver
          signed events to your systems — all scoped to this project.
        </p>
      </div>
      <AutomationPanel projectId={id} />
    </div>
  );
}
