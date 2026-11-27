import { useEffect, useRef, type ReactNode } from 'react';

export function Alert({ kind, children }: { kind: 'error' | 'success' | 'info' | 'warning'; children: ReactNode }) {
  const styles: Record<string, string> = {
    error: 'border-rose-200 bg-rose-50 text-rose-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
  };
  return (
    <div role="alert" className={`rounded-lg border px-4 py-3 text-sm leading-6 ${styles[kind]}`}>
      {children}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function Badge({ tone, children }: { tone: 'green' | 'amber' | 'red' | 'slate' | 'blue'; children: ReactNode }) {
  const tones: Record<string, string> = {
    green: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    red: 'bg-rose-100 text-rose-800',
    slate: 'bg-slate-100 text-slate-700',
    blue: 'bg-sky-100 text-sky-800',
  };
  return <span className={`badge ${tones[tone]}`}>{children}</span>;
}

export function Spinner({ label = 'جارٍ التحميل…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-500" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
      {label}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center">
      <p className="font-semibold text-slate-700">{title}</p>
      <p className="mt-1 text-sm text-slate-500">{description}</p>
    </div>
  );
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  } catch {
    return value;
  }
}

/**
 * حوار تأكيد للإجراءات الخطرة (P0 — تدقيق ما قبل التسليم).
 *
 * لماذا مكوّن وليس `window.confirm`: الحوار يشرح **ماذا** سيحدث (اسم الوجهة/المسار،
 * نص المنشور) بدل سؤال عام، ويُعلن نفسه لقارئ الشاشة (`role="dialog"` + `aria-modal`)،
 * ويستقبل التركيز، ويُغلق بـ Escape. نقرة خاطئة واحدة كانت كافية لإسكات قناة عميل.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  details,
  confirmLabel,
  cancelLabel = 'تراجع',
  tone = 'danger',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  /** سطور توضيحية (اسم الوجهة، عدد الأجزاء، نص مختصر…) — نص فقط. */
  details?: { label: string; value: string }[];
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // التركيز الافتراضي على «تراجع»: النمط الآمن هو الأسهل.
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onCancel();
      if (event.key === 'Tab') {
        const first = cancelRef.current;
        const last = confirmRef.current;
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;
  const confirmClasses =
    tone === 'danger'
      ? 'btn bg-rose-600 text-white hover:bg-rose-700 focus-visible:ring-rose-400'
      : 'btn btn-primary';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-description"
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl"
      >
        <h2 id="confirm-title" className="text-lg font-bold text-slate-900">
          {title}
        </h2>
        <div id="confirm-description" className="mt-2 text-sm leading-6 text-slate-600">
          {description}
        </div>
        {details && details.length > 0 ? (
          <dl className="mt-4 space-y-1 rounded-lg bg-slate-50 p-3 text-sm">
            {details.map((item) => (
              <div key={item.label} className="flex justify-between gap-3">
                <dt className="text-slate-500">{item.label}</dt>
                <dd className="font-medium text-slate-800">{item.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button ref={cancelRef} type="button" className="btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button ref={confirmRef} type="button" className={confirmClasses} onClick={onConfirm} disabled={busy}>
            {busy ? 'جارٍ التنفيذ…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
