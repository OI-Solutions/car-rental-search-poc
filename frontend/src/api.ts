/**
 * Thin API client. All calls go through the Express backend — the frontend never
 * talks to OpenSearch and never sees its credentials.
 *
 * The dev token is kept in localStorage. That is acceptable only for this local
 * POC; it is NOT a secure token store for production.
 */
import type {
  SearchMeta,
  SearchRequest,
  SearchResponse,
  SessionProfile,
} from "./types";

const BASE = (import.meta.env.VITE_API_BASE_URL as string) ?? "http://localhost:4000";
const TOKEN_KEY = "crs_dev_token";
const PROFILE_KEY = "crs_dev_profile";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function getStoredProfile(): SessionProfile | null {
  const raw = localStorage.getItem(PROFILE_KEY);
  return raw ? (JSON.parse(raw) as SessionProfile) : null;
}
export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(PROFILE_KEY);
}

async function asError(res: Response): Promise<Error> {
  let msg = `${res.status} ${res.statusText}`;
  try {
    const body = await res.json();
    if (body?.message) msg = body.message;
  } catch {
    /* ignore */
  }
  return new Error(msg);
}

export async function listUsers(): Promise<SessionProfile[]> {
  const res = await fetch(`${BASE}/api/dev/users`);
  if (!res.ok) throw await asError(res);
  return (await res.json()).users as SessionProfile[];
}

export async function createSession(userId: string): Promise<SessionProfile> {
  const res = await fetch(`${BASE}/api/dev/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  });
  if (!res.ok) throw await asError(res);
  const data = (await res.json()) as { token: string; profile: SessionProfile };
  localStorage.setItem(TOKEN_KEY, data.token);
  localStorage.setItem(PROFILE_KEY, JSON.stringify(data.profile));
  return data.profile;
}

export async function fetchMeta(): Promise<SearchMeta> {
  const res = await fetch(`${BASE}/api/meta`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw await asError(res);
  return (await res.json()) as SearchMeta;
}

export async function search(req: SearchRequest): Promise<SearchResponse> {
  const res = await fetch(`${BASE}/api/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
    },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw await asError(res);
  return (await res.json()) as SearchResponse;
}
