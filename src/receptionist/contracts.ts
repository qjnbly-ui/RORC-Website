export type Intent = "simple_question" | "detailed_explanation" | "send_information" | "start_form" | "check_account" | "request_person";
export type DetailLevel = "brief" | "normal" | "detailed";
export type FormId = "none" | "membership" | "rental" | "sponsor";
export type FormAction = "none" | "offer" | "guided" | "send_link";
export type LiveDataSource = "none" | "facility" | "events" | "both";
export type LiveFact = "none" | "temperature" | "humidity" | "occupancy" | "activity_trends" | "busiest_time" | "quietest_time" | "checkins" | "member_counts" | "schedule" | "facility_hours" | "rental_availability";

export interface HistoryItem {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface IntentResult {
  intent: Intent;
  confidence: number;
  topic: string;
  detail_level: DetailLevel;
  form_id: FormId;
  form_action: FormAction;
  person_name: string;
  live_data: LiveDataSource;
  live_fact: LiveFact;
  source: "model" | "fallback";
  needsClarification?: boolean;
}

export interface FacilityTrendsPoint { day: string; hour: string; count: number }
export interface FacilityTrends {
  weeksAnalyzed: number;
  busiest: FacilityTrendsPoint;
  quietest: FacilityTrendsPoint;
  [key: string]: unknown;
}
export interface FacilityActivity {
  occupancyCount: number | null;
  roomTemperatureF: number | null;
  roomHumidity: number | null;
  checkinsToday: number | null;
  checkinsThisWeek: number | null;
  checkinsThisMonth: number | null;
  activeMembers: number | null;
  activeMemberAccounts: number | null;
  weeklyTrends: FacilityTrends | null;
  [key: string]: unknown;
}
export interface FacilityPayload {
  success: true;
  activity: FacilityActivity;
  partial?: boolean;
  unavailable?: string[];
  carriedForward?: boolean;
}
export interface PublicEvent { title?: string; startAt?: string; endAt?: string; [key: string]: unknown }
export interface EventsPayload { success: true; events: PublicEvent[]; facilityHours?: unknown; facilityBlocks?: unknown[] }
export type Freshness = "fresh" | "stale" | "unavailable" | "skipped";
export interface LiveSource<T> { data: T | null; freshness: Freshness; savedAt: number | null; error: string }
export interface LiveSnapshot {
  facility: LiveSource<FacilityPayload>;
  events: LiveSource<EventsPayload>;
  loadedAt: string;
}

export interface FormField {
  key: string;
  type: "choice" | "yesno" | "yesno-title" | "phone" | "email" | "date" | "time" | "number" | "text";
  prompt: string;
  callerPhoneAllowed?: boolean;
  options?: Record<string, string[]>;
}
export interface FormDefinition { id: string; title: string; url: string; fields: FormField[] }
export interface FormSession { formId: string; fieldIndex: number; answers: Record<string, string | number> }

export interface RouterDetectors {
  detectFormRequest?: (value: string) => string;
  isAccountRequest?: (value: string) => boolean;
  isSmsRequest?: (value: string) => boolean;
  isPersonRequest?: (value: string) => boolean;
  wantsDetailedAnswer?: (value: string) => boolean;
  isGuidedFormChoice?: (value: string) => boolean;
  isDirectFormChoice?: (value: string) => boolean;
}

export interface FetchOptions {
  fetch?: typeof fetch;
  now?: number;
  attempts?: number;
  timeoutMs?: number;
  freshMs?: number;
  staleMs?: number;
  baseUrl?: string;
  sources?: Array<"facility" | "events">;
}
