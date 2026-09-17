import { AppShell } from '../../components/AppShell';

export function DashboardStub({ title, milestone }: { title: string; milestone: string }) {
  return (
    <AppShell title={title}>
      <p>This dashboard is scaffolded but not yet built out — see {milestone} in the implementation plan.</p>
    </AppShell>
  );
}
