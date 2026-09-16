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
        <h2>Automations</h2>
        <p>Work that runs on a timetable, on a queue, or on an event.</p>
      </div>
      <AutomationPanel projectId={id} />
    </div>
  );
}
