const DEFAULT_FRESH_MS = 60 * 1000;
const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 5500;
const DEFAULT_ATTEMPTS = 2;
import type { EventsPayload, FacilityPayload, FetchOptions, Freshness, LiveSnapshot, LiveSource } from "./contracts";

interface CacheEntry<T> { data: T; freshness: Freshness; savedAt: number }
const cache = new Map<string, CacheEntry<FacilityPayload | EventsPayload>>();

function publicBaseUrl() {
  return String(process.env.RORC_PUBLIC_BASE_URL || "https://www.ruthobenchainrc.com").replace(/\/+$/, "");
}

function compactFacility(payload: unknown): FacilityPayload | null {
  const item = payload as { success?: boolean; activity?: FacilityPayload["activity"]; partial?: boolean; unavailable?: string[] } | null;
  if (!item || item.success === false || !item.activity) return null;
  return { success: true, activity: item.activity, partial: Boolean(item.partial), unavailable: item.unavailable || [] };
}

function compactEvents(payload: unknown): EventsPayload | null {
  const item = payload as { success?: boolean; events?: EventsPayload["events"]; facilityHours?: unknown; facilityBlocks?: unknown[] } | null;
  if (!item || item.success === false) return null;
  return {
    success: true,
    events: (Array.isArray(item.events) ? item.events : []).slice(0, 80),
    facilityHours: item.facilityHours || null,
    facilityBlocks: (Array.isArray(item.facilityBlocks) ? item.facilityBlocks : []).slice(0, 80),
  };
}

function carryForwardFacility(current: FacilityPayload, previous?: FacilityPayload): FacilityPayload {
  if (!current?.partial || !previous?.activity) return current;
  const activity = { ...(current.activity || {}) };
  for (const [key, value] of Object.entries(previous.activity)) {
    if ((activity[key] === null || activity[key] === undefined) && value !== null && value !== undefined) activity[key] = value;
  }
  return { ...current, activity, carriedForward: true };
}

async function fetchJsonWithRetry(url: string, options: FetchOptions = {}): Promise<unknown> {
  const fetcher = options.fetch || fetch;
  const attempts = Math.max(1, Number(options.attempts || DEFAULT_ATTEMPTS));
  const timeoutMs = Math.max(250, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.success === false) {
        const error = new Error(String((body as { error?: unknown } | null)?.error || `Live data request failed (${response.status}).`)) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      return body;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Live data request failed.");
}

async function loadSource<T extends FacilityPayload | EventsPayload>(name: "facility" | "events", path: string, compact: (payload: unknown) => T | null, options: FetchOptions = {}): Promise<LiveSource<T>> {
  const now = Number(options.now || Date.now());
  const freshMs = Number(options.freshMs || DEFAULT_FRESH_MS);
  const staleMs = Number(options.staleMs || DEFAULT_STALE_MS);
  const existing = cache.get(name) as CacheEntry<T> | undefined;
  if (existing && now - existing.savedAt <= freshMs) {
    return { data: existing.data, freshness: existing.freshness || "fresh", savedAt: existing.savedAt, error: "" };
  }

  try {
    const payload = await fetchJsonWithRetry(`${options.baseUrl || publicBaseUrl()}${path}`, options);
    const compacted = compact(payload);
    if (!compacted) throw new Error(`${name} returned no usable data.`);
    const data = (name === "facility" ? carryForwardFacility(compacted as FacilityPayload, existing?.data as FacilityPayload | undefined) : compacted) as T;
    const freshness: Freshness = name === "facility" && Boolean((data as FacilityPayload).carriedForward) ? "stale" : "fresh";
    const entry = { data, freshness, savedAt: now };
    cache.set(name, entry);
    return { data, freshness, savedAt: now, error: "" };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (existing && now - existing.savedAt <= staleMs) {
      return { data: existing.data, freshness: "stale", savedAt: existing.savedAt, error: message };
    }
    return { data: null, freshness: "unavailable", savedAt: null, error: message };
  }
}

async function loadReceptionistLiveData(options: FetchOptions = {}): Promise<LiveSnapshot> {
  const sources = new Set(Array.isArray(options.sources) && options.sources.length ? options.sources : ["facility", "events"]);
  const skipped: LiveSource<never> = { data: null, freshness: "skipped", savedAt: null, error: "" };
  const [facility, events] = await Promise.all([
    sources.has("facility") ? loadSource("facility", "/api/facility-activity", compactFacility, options) : Promise.resolve(skipped),
    sources.has("events") ? loadSource("events", "/api/events", compactEvents, options) : Promise.resolve(skipped),
  ]);
  return { facility, events, loadedAt: new Date(Number(options.now || Date.now())).toISOString() };
}

function liveContextText(snapshot: LiveSnapshot): string {
  const context: Record<string, unknown> = {};
  if (snapshot?.facility?.data) {
    context.facility = {
      freshness: snapshot.facility.freshness,
      savedAt: snapshot.facility.savedAt ? new Date(snapshot.facility.savedAt).toISOString() : null,
      ...snapshot.facility.data,
    };
  }
  if (snapshot?.events?.data) {
    context.events = {
      freshness: snapshot.events.freshness,
      savedAt: snapshot.events.savedAt ? new Date(snapshot.events.savedAt).toISOString() : null,
      ...snapshot.events.data,
    };
  }
  return Object.keys(context).length ? `LIVE RORC DATA: ${JSON.stringify(context).slice(0, 20000)}` : "";
}

function resetLiveDataCache() {
  cache.clear();
}

module.exports = {
  compactEvents,
  compactFacility,
  fetchJsonWithRetry,
  liveContextText,
  loadReceptionistLiveData,
  resetLiveDataCache,
};
