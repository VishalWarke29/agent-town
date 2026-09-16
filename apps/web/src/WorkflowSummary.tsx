import { AlertTriangle, BookOpen, Leaf, ShieldCheck } from 'lucide-react';
import type { WorkflowState } from '@agent-town/contracts';
import { money } from './money';

export function WorkflowSummary({ workflow }: { workflow: WorkflowState }) {
  const spent = workflow.reservations.reduce((total, item) => total + (item.actualMicroUsd ?? 0), 0);
  const held = workflow.reservations.filter(item => item.status !== 'settled').reduce((total, item) => total + item.amountMicroUsd, 0);
  const uncertain = workflow.reservations.filter(item => item.status === 'uncertain');
  const nearLimit = [...workflow.reservations].reverse().find(item => item.status !== 'settled' && item.nearLimit);
  return <>
    <div className="usage-total"><span>Recorded Agent Town API cost</span><strong>{money(spent)}</strong><small><Leaf size={14} />Tracking and animation use zero model calls</small></div>
    <dl className="facts"><div><dt>Open reservations</dt><dd>{money(held)}</dd></div><div><dt>Workspace daily limit</dt><dd>{money(workflow.policy.dailyBudgetMicroUsd)}</dd></div><div><dt>Manager daily allowance</dt><dd>{money(workflow.policy.managerDailyBudgetMicroUsd)}</dd></div><div><dt>Paid work</dt><dd>{workflow.policy.paidEnabled ? 'Enabled within saved limits' : 'Disabled'}</dd></div><div><dt>Provider credit balance</dt><dd>Unavailable</dd></div></dl>
    {nearLimit && <div className="note"><AlertTriangle size={16} /><p><strong>Approaching a local budget limit:</strong> the {nearLimit.purpose === 'manager' ? 'manager' : 'worker'} request {nearLimit.id} reached 80% or more of its run, daily, or manager budget. Scheduling still works up to the limit; review your saved limits before it is reached.</p></div>}
    {uncertain.length > 0 && <div className="note"><ShieldCheck size={16} /><p>{uncertain.length} request{uncertain.length === 1 ? ' has' : 's have'} an uncertain outcome. Its reservation stays held until usage is reconciled. Recorded cost may exclude those requests.</p></div>}
    <h3 className="subheading">Requests and reservations</h3>
    {workflow.reservations.length === 0 && <p className="empty">No paid requests have been scheduled in this workspace.</p>}
    {[...workflow.reservations].reverse().map(item => <article className="usage-entry" key={item.id}><div className="section-summary"><strong>{item.purpose === 'manager' ? 'Manager summary' : 'Worker request'}</strong><span>{item.status === 'reserved' ? 'Reserved' : item.status === 'uncertain' ? 'Outcome uncertain' : 'Settled'}</span></div><p>{workflow.connections.find(connection => connection.id === item.connectionId)?.label ?? 'Saved connection'} · {item.provider} · API</p><dl><div><dt>Model</dt><dd className="mono">{item.model.model}</dd></div><div><dt>Reserved</dt><dd>{money(item.amountMicroUsd)}</dd></div><div><dt>Recorded cost</dt><dd>{item.actualMicroUsd === null ? 'Unavailable' : money(item.actualMicroUsd)}</dd></div><div><dt>Input / output tokens</dt><dd>{item.usage ? `${item.usage.inputTokens.toLocaleString()} / ${item.usage.outputTokens.toLocaleString()}` : 'Unavailable'}</dd></div><div><dt>Cached input tokens</dt><dd>{item.usage ? item.usage.cachedInputTokens.toLocaleString() : 'Unavailable'}</dd></div><div><dt>Usage source</dt><dd>{item.usage?.source ?? 'Awaiting provider usage'}</dd></div></dl></article>)}
    <div className="note"><BookOpen size={16} /><p>Costs use the price saved for each request. Local limits and recorded estimates are separate from the provider’s invoice and account balance.</p></div>
  </>;
}
