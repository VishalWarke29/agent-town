import { useEffect, useReducer } from 'react';
import type { TownState } from '@agent-town/contracts';
import { canUseDesk, ROOM_PAGE_SIZE, type RoomView } from './world/interaction';

interface Navigation { scope: string; repoId: string | null; showingRoom: boolean; slots: (string | null)[]; page: number }
type Action = { type: 'enter'; scope: string; repoId: string; ids: string[] } | { type: 'reconcile'; ids: string[] } | { type: 'page'; page: number } | { type: 'away' } | { type: 'clear' };
const empty: Navigation = { scope: '', repoId: null, showingRoom: false, slots: [], page: 0 };

export function stableResidentOrder(previous: string[], incoming: string[]): string[] {
  const live = new Set(incoming), known = new Set(previous);
  return [...previous.filter(id => live.has(id)), ...incoming.filter(id => !known.has(id)).sort()];
}

/** Stable presentation slots only; a vacancy never changes another session's desk. */
export function reconcileDeskSlots(previous: readonly (string | null)[], incoming: readonly string[]): (string | null)[] {
  const eligible = new Set(incoming), assigned = new Set<string>();
  const slots = previous.map(id => {
    if (id === null || !eligible.has(id) || assigned.has(id)) return null;
    assigned.add(id); return id;
  });
  for (const id of [...eligible].sort()) {
    if (assigned.has(id)) continue;
    const vacancy = slots.indexOf(null);
    if (vacancy < 0) slots.push(id); else slots[vacancy] = id;
    assigned.add(id);
  }
  while (slots.length && slots.at(-1) === null) slots.pop();
  return slots;
}

function reducer(current: Navigation, action: Action): Navigation {
  switch (action.type) {
    case 'enter': return current.scope === action.scope && current.repoId === action.repoId
      ? { ...current, showingRoom: true, slots: reconcileDeskSlots(current.slots, action.ids) }
      : { scope: action.scope, repoId: action.repoId, showingRoom: true, slots: reconcileDeskSlots([], action.ids), page: 0 };
    case 'reconcile': return { ...current, slots: reconcileDeskSlots(current.slots, action.ids) };
    case 'page': return { ...current, page: Math.max(0, action.page) };
    case 'away': return { ...current, showingRoom: false };
    case 'clear': return empty;
  }
}

export function useWorldNavigation(scope: string, state: TownState | undefined) {
  const [stored, dispatch] = useReducer(reducer, empty);
  const validScope = stored.scope === scope;
  const repository = validScope ? state?.repositories.find(repo => repo.id === stored.repoId) : undefined;
  const residents = repository ? state!.agents.filter(agent => agent.repoId === repository.id) : [];
  const eligibleIds = residents.filter(canUseDesk).map(agent => agent.id);
  const membership = [...eligibleIds].sort().join('\u0000');
  useEffect(() => {
    if (!validScope || (state && stored.repoId && !repository)) { dispatch({ type: 'clear' }); return; }
    if (repository) dispatch({ type: 'reconcile', ids: eligibleIds });
    // Eligibility changes free or fill slots; working/testing updates preserve every desk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, validScope, repository?.id, membership, Boolean(state), stored.repoId]);
  // Derive immediately so a reporting/removed agent never retains a desk for one frame.
  const deskSlots = reconcileDeskSlots(validScope ? stored.slots : [], eligibleIds);
  const deskCount = deskSlots.filter(id => id !== null).length;
  const pageCount = Math.max(1, Math.ceil(deskSlots.length / ROOM_PAGE_SIZE));
  const page = Math.min(stored.page, pageCount - 1);
  useEffect(() => { if (page !== stored.page) dispatch({ type: 'page', page }); }, [page, stored.page]);
  const room: RoomView | null = repository && stored.showingRoom ? { repoId: repository.id, agentIds: deskSlots.slice(page * ROOM_PAGE_SIZE, (page + 1) * ROOM_PAGE_SIZE) } : null;
  return {
    repository, residents, room, page, pageCount, deskCount, deskSlots,
    invalidated: validScope && Boolean(stored.repoId && state && !repository),
    enter: (repoId: string) => dispatch({ type: 'enter', scope, repoId, ids: state?.agents.filter(agent => agent.repoId === repoId && canUseDesk(agent)).map(agent => agent.id) ?? [] }),
    setPage: (next: number) => dispatch({ type: 'page', page: Math.min(pageCount - 1, next) }),
    revealAgent: (id: string) => { const index = deskSlots.indexOf(id); if (index >= 0) dispatch({ type: 'page', page: Math.floor(index / ROOM_PAGE_SIZE) }); },
    away: () => dispatch({ type: 'away' }),
    clear: () => dispatch({ type: 'clear' }),
  };
}
