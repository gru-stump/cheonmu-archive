import { useId, type ReactNode } from 'react';

export function AdminSection({ title, description, action, children, className = '' }: { title: string; description?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  const headingId = useId();
  return <section className={`admin-section ${className}`.trim()} aria-labelledby={headingId}>
    <header className="admin-section__header">
      <div><h2 id={headingId}>{title}</h2>{description && <p>{description}</p>}</div>
      {action && <div className="admin-section__action">{action}</div>}
    </header>
    <div className="admin-section__body">{children}</div>
  </section>;
}
