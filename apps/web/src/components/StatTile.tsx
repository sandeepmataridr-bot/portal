export function StatTile({ label, value, tone }: { label: string; value: string | number; tone?: 'warning' | 'success' | 'danger' | 'info' }) {
  return (
    <div className={`stat-tile${tone ? ` stat-tile--${tone}` : ''}`}>
      <div className="stat-tile__value">{value}</div>
      <div className="stat-tile__label">{label}</div>
    </div>
  );
}
