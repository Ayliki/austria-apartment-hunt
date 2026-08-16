import type { SearchProfilePrefs } from './db.js';

/**
 * Pure onboarding/edit wizard state machine — the button-chip flow that replaces the old linear
 * text onboarding. Deliberately free of any Telegraf/DB import so it's trivially unit-testable;
 * `bot.ts` (Task 6) renders each step's locale key + choices into an actual Telegram keyboard and
 * persists `WizardState` between updates.
 */
export type WizardStepId = 'name' | 'budget' | 'districts' | 'rooms_size' | 'amenities' | 'commute';

export const WIZARD_STEPS: WizardStepId[] = ['name', 'budget', 'districts', 'rooms_size', 'amenities', 'commute'];

export interface WizardState {
  stepIndex: number;
  profileName: string | null;
  partial: Partial<SearchProfilePrefs>;
  /** Non-null means `/settings` jumped straight to editing one step of an existing profile (see Task 6) rather than running the full onboarding flow. */
  editingProfileId: number | null;
  /** True when the user tapped "Custom range" on the budget step and the next free-text message should be parsed as a custom price range. */
  awaitingCustomBudget: boolean;
}

export function initialWizardState(): WizardState {
  return { stepIndex: 0, profileName: null, partial: {}, editingProfileId: null, awaitingCustomBudget: false };
}

export type WizardChoice =
  | { kind: 'name'; name: string }
  | { kind: 'budget'; priceFrom: number | null; priceTo: number }
  | { kind: 'budget_custom' }
  | { kind: 'districts_toggle'; district: number }
  | { kind: 'districts_continue' }
  // areaFrom/areaTo are accepted for backward compatibility with older callers/tests but are never
  // actually applied (see applyWizardChoice's 'rooms_size' case below) — this step only ever offers
  // room-count chips, never an area range, so it must not silently clobber a profile's existing area
  // filter (e.g. one carried over from a pre-search-profiles migration) when only rooms is edited.
  | { kind: 'rooms_size'; roomsFrom: number | null; roomsTo: number | null; areaFrom?: number | null; areaTo?: number | null }
  | { kind: 'amenity_toggle'; field: 'requireElevator' | 'requireParking' | 'includeWaitlistHousing' | 'includeWg' }
  | { kind: 'amenities_continue' }
  | { kind: 'commute_skip' }
  | { kind: 'commute_set'; destination: string; lat: number; lon: number }
  | { kind: 'back' };

export const BUDGET_BANDS: { label: string; priceFrom: number | null; priceTo: number }[] = [
  // priceFrom: null here means "no minimum" — without this band the cheapest chip (€500-700) hard-
  // excluded anything under €500, with no escape hatch for someone whose budget is genuinely lower.
  { label: 'Under €500', priceFrom: null, priceTo: 500 },
  { label: '€500-700', priceFrom: 500, priceTo: 700 },
  { label: '€700-900', priceFrom: 700, priceTo: 900 },
  { label: '€900-1100', priceFrom: 900, priceTo: 1100 },
  // Infinity here means "no upper bound" — JSON.stringify(Infinity) serializes to `null`, so this
  // round-trips through db.ts's prefs_json column as priceTo: null, which matchesPrefs/
  // getCandidateListings already treat as unbounded. See finalizePrefs below.
  { label: '€1100+', priceFrom: 1100, priceTo: Infinity },
];

export const DISTRICT_GROUPS: { label: string; districts: number[] }[] = [
  { label: '1-9', districts: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
  { label: '10-23', districts: Array.from({ length: 14 }, (_, i) => i + 10) },
];

function currentStep(state: WizardState): WizardStepId {
  return WIZARD_STEPS[state.stepIndex];
}

/** Pure state transition — throws if `choice` doesn't belong to the step the wizard is currently on (a stale/duplicate button tap after the message already advanced). */
export function applyWizardChoice(state: WizardState, choice: WizardChoice): WizardState {
  if (choice.kind === 'back') {
    if (state.stepIndex === 0) return state;
    const prevStep = WIZARD_STEPS[state.stepIndex - 1];
    const partial = { ...state.partial };
    const clearedByStep: Record<WizardStepId, (keyof SearchProfilePrefs)[]> = {
      name: [],
      budget: ['priceFrom', 'priceTo'],
      districts: ['districts'],
      // Not areaFrom/areaTo — this step never sets them (see WizardChoice's 'rooms_size' comment
      // above), so going back from it must not clear an area filter it never touched.
      rooms_size: ['roomsFrom', 'roomsTo'],
      amenities: ['requireElevator', 'requireParking', 'includeWaitlistHousing', 'includeWg'],
      commute: ['commuteDestination', 'commuteLat', 'commuteLon'],
    };
    for (const field of clearedByStep[prevStep]) delete partial[field];
    return { ...state, stepIndex: state.stepIndex - 1, partial, profileName: prevStep === 'name' ? null : state.profileName };
  }

  const step = currentStep(state);
  switch (choice.kind) {
    case 'name':
      if (step !== 'name') throw new Error(`wizard is on step "${step}", not "name"`);
      return { ...state, stepIndex: state.stepIndex + 1, profileName: choice.name };
    case 'budget':
      if (step !== 'budget') throw new Error(`wizard is on step "${step}", not "budget"`);
      return { ...state, stepIndex: state.stepIndex + 1, awaitingCustomBudget: false, partial: { ...state.partial, priceFrom: choice.priceFrom, priceTo: choice.priceTo } };
    case 'budget_custom':
      if (step !== 'budget') throw new Error(`wizard is on step "${step}", not "budget"`);
      return { ...state, awaitingCustomBudget: true };
    case 'districts_toggle': {
      if (step !== 'districts') throw new Error(`wizard is on step "${step}", not "districts"`);
      const current = state.partial.districts ?? [];
      const districts = current.includes(choice.district)
        ? current.filter((d) => d !== choice.district)
        : [...current, choice.district].sort((a, b) => a - b);
      return { ...state, partial: { ...state.partial, districts } };
    }
    case 'districts_continue':
      if (step !== 'districts') throw new Error(`wizard is on step "${step}", not "districts"`);
      return { ...state, stepIndex: state.stepIndex + 1 };
    case 'rooms_size':
      if (step !== 'rooms_size') throw new Error(`wizard is on step "${step}", not "rooms_size"`);
      // Deliberately does NOT touch areaFrom/areaTo — this step only ever offers room-count chips
      // (1/2/3+/Any), never an area range, so a pre-existing area filter (e.g. carried over from a
      // pre-search-profiles migration, or set by some future step) must survive an edit made here.
      return {
        ...state,
        stepIndex: state.stepIndex + 1,
        partial: { ...state.partial, roomsFrom: choice.roomsFrom, roomsTo: choice.roomsTo },
      };
    case 'amenity_toggle': {
      if (step !== 'amenities') throw new Error(`wizard is on step "${step}", not "amenities"`);
      const currentValue = Boolean(state.partial[choice.field]);
      return { ...state, partial: { ...state.partial, [choice.field]: !currentValue } };
    }
    case 'amenities_continue':
      if (step !== 'amenities') throw new Error(`wizard is on step "${step}", not "amenities"`);
      return {
        ...state,
        stepIndex: state.stepIndex + 1,
        partial: {
          ...state.partial,
          requireElevator: state.partial.requireElevator ?? false,
          requireParking: state.partial.requireParking ?? false,
          includeWaitlistHousing: state.partial.includeWaitlistHousing ?? false,
          includeWg: state.partial.includeWg ?? false,
        },
      };
    case 'commute_skip':
      if (step !== 'commute') throw new Error(`wizard is on step "${step}", not "commute"`);
      return { ...state, stepIndex: state.stepIndex + 1, partial: { ...state.partial, commuteDestination: null, commuteLat: null, commuteLon: null } };
    case 'commute_set':
      if (step !== 'commute') throw new Error(`wizard is on step "${step}", not "commute"`);
      return {
        ...state,
        stepIndex: state.stepIndex + 1,
        partial: { ...state.partial, commuteDestination: choice.destination, commuteLat: choice.lat, commuteLon: choice.lon },
      };
  }
}

export function isWizardComplete(state: WizardState): boolean {
  return state.stepIndex >= WIZARD_STEPS.length;
}

/**
 * Parses free-text budget input into a price range. Supported shapes (case-insensitive, € and spaces
 * ignored): "500-1200", "<1200", "under 1200", "500+", "from 500", "max 800", or a bare number
 * (treated as the upper limit). Returns null for anything that can't be confidently interpreted.
 */
export function parseCustomBudget(input: string): { priceFrom: number | null; priceTo: number | null } | null {
  const s = input.replace(/[€\s]/g, '').toLowerCase();
  if (!s) return null;

  const rangeMatch = s.match(/^(\d+)[\-–](\d+)$/);
  if (rangeMatch) {
    const from = Number(rangeMatch[1]);
    const to = Number(rangeMatch[2]);
    if (from >= to || from < 0 || to < 0) return null;
    return { priceFrom: from, priceTo: to };
  }

  const maxMatch = s.match(/^(?:<|under|max|upto)(\d+)$/);
  if (maxMatch) {
    const to = Number(maxMatch[1]);
    return to >= 0 ? { priceFrom: null, priceTo: to } : null;
  }

  const minMatch = s.match(/^(\d+)\+$/);
  if (minMatch) {
    const from = Number(minMatch[1]);
    return from >= 0 ? { priceFrom: from, priceTo: null } : null;
  }
  const minKeywordMatch = s.match(/^(?:>|from|min)(\d+)$/);
  if (minKeywordMatch) {
    const from = Number(minKeywordMatch[1]);
    return from >= 0 ? { priceFrom: from, priceTo: null } : null;
  }

  const singleMatch = s.match(/^(\d+)$/);
  if (singleMatch) {
    const to = Number(singleMatch[1]);
    return to >= 0 ? { priceFrom: null, priceTo: to } : null;
  }

  return null;
}

/** Throws if the wizard hasn't reached the end — callers must check isWizardComplete first. Fills in the neutral default for any optional step that was somehow never visited (e.g. jumping straight from districts to commute via editingProfileId). */
export function finalizePrefs(state: WizardState): SearchProfilePrefs {
  if (!isWizardComplete(state)) throw new Error('wizard is not complete yet');
  const p = state.partial;
  return {
    priceFrom: p.priceFrom ?? null,
    // Normalize BUDGET_BANDS' Infinity (and an unvisited budget step) to null here, rather than
    // relying on JSON.stringify(Infinity) -> null happening later at the db.ts persistence layer.
    // createSearchProfile() returns the caller's in-memory prefs object verbatim (it doesn't
    // re-read the inserted row), so without this normalization the object handed back right after
    // profile creation would still carry priceTo: Infinity while a subsequent DB read of the same
    // profile would show priceTo: null — an inconsistency. null is the established "no upper
    // bound" convention (see db.ts's matchesPrefs/getCandidateListings), so this removes the
    // second/inconsistent encoding entirely instead of working around it downstream.
    priceTo: p.priceTo === Infinity || p.priceTo == null ? null : p.priceTo,
    districts: p.districts && p.districts.length > 0 ? p.districts : null,
    roomsFrom: p.roomsFrom ?? null,
    roomsTo: p.roomsTo ?? null,
    areaFrom: p.areaFrom ?? null,
    areaTo: p.areaTo ?? null,
    includeWaitlistHousing: p.includeWaitlistHousing ?? false,
    includeWg: p.includeWg ?? false,
    requireElevator: p.requireElevator ?? false,
    requireParking: p.requireParking ?? false,
    commuteDestination: p.commuteDestination ?? null,
    commuteLat: p.commuteLat ?? null,
    commuteLon: p.commuteLon ?? null,
  };
}
