import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function EvidenceDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const opener = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog className="evidence-dialog glass" ref={ref} aria-label={title} aria-modal="true" onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const controls = Array.from(ref.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')).filter(node => node.offsetParent !== null);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }}><header className="drawer-header"><div><p className="eyebrow">SAVED EVIDENCE</p><h2>{title}</h2></div><button className="icon-button" aria-label="Close evidence" onClick={onClose}><X size={20} /></button></header><div className="evidence-content" tabIndex={0} role="region" aria-label={`${title} contents`}>{children}</div></dialog>;
}
