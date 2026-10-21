export function StatTile({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: string | number;
  tone?: 'warning' | 'success' | 'danger' | 'info';
  onClick?: () => void;
}) {
  const className = `stat-tile${tone ? ` stat-tile--${tone}` : ''}${onClick ? ' stat-tile--clickable' : ''}`;
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick}>
        <div className="stat-tile__value">{value}</div>
        <div className="stat-tile__label">{label}</div>
      </button>
    );
  }
  return (
    <div className={className}>
      <div className="stat-tile__value">{value}</div>
      <div className="stat-tile__label">{label}</div>
    </div>
  );
}
