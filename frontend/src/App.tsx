import { useEffect, useState } from "react";
import type { SearchMeta, SearchRequest, SearchResponse, SessionProfile } from "./types";
import { createSession, fetchMeta, getStoredProfile, search } from "./api";
import { UserSwitcher } from "./components/UserSwitcher";
import { SearchControls } from "./components/SearchControls";
import { Results } from "./components/Results";
import { ProcurementSearch } from "./components/ProcurementSearch";
import { DevDataNote } from "./components/DevDataNote";
import { UnderTheHood } from "./components/UnderTheHood";

const EMPTY_SEARCH: SearchRequest = { sort: "relevance" };

type SearchMode = "basic" | "procurement";

export function App() {
  const [profile, setProfile] = useState<SessionProfile | null>(getStoredProfile());
  const [meta, setMeta] = useState<SearchMeta | null>(null);
  const [req, setReq] = useState<SearchRequest>(EMPTY_SEARCH);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<SearchMode>("basic");
  const [explain, setExplain] = useState(false);

  const isCustomer = profile?.role === "customer_user";

  // Load dropdown metadata whenever we have an active session.
  useEffect(() => {
    if (!profile) return;
    fetchMeta()
      .then(setMeta)
      .catch(() => setMeta(null));
  }, [profile]);

  async function handleSelectUser(userId: string) {
    setError(null);
    try {
      const p = await createSession(userId);
      setProfile(p);
      // Switching identity clears prior results so nothing stale is shown.
      setData(null);
      // Personalized sort only makes sense for customer users.
      if (p.role !== "customer_user" && req.sort === "personalized_price_asc") {
        setReq({ ...req, sort: "relevance" });
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleSearch() {
    if (!profile) return;
    setLoading(true);
    setError(null);
    try {
      setData(await search(req, explain));
    } catch (e) {
      setError((e as Error).message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  function handleClear() {
    setReq(EMPTY_SEARCH);
    setData(null);
    setError(null);
  }

  return (
    <div className="wrap">
      <h1>B2B Car-Rental — Protected Personalized Search</h1>
      <div className="dev-banner">
        ⚠️ <b>Development only.</b> Mock authentication over synthetic users — no real
        passwords, no production identity. The user switcher below impersonates seeded
        identities to demonstrate role- and tenant-dependent behavior.
        <DevDataNote />
      </div>

      <UserSwitcher active={profile} onSelect={handleSelectUser} />

      {!profile ? (
        <div className="card state muted">Select a user above to start searching.</div>
      ) : (
        <>
          <div className="segmented" role="tablist" aria-label="Search mode">
            <button
              role="tab"
              aria-selected={mode === "basic"}
              className={mode === "basic" ? "seg active" : "seg"}
              onClick={() => setMode("basic")}
            >
              Basic Search
            </button>
            <button
              role="tab"
              aria-selected={mode === "procurement"}
              className={mode === "procurement" ? "seg active" : "seg"}
              onClick={() => setMode("procurement")}
            >
              Procurement Search
            </button>
          </div>

          {mode === "basic" ? (
            <>
              <SearchControls
                meta={meta}
                value={req}
                onChange={setReq}
                onSearch={handleSearch}
                onClear={handleClear}
                loading={loading}
                showPersonalizedSort={!!isCustomer}
              />
              <label className="check explain-toggle" title="Show the controlled query, raw→redacted diff, and pricing math for this search">
                <input
                  type="checkbox"
                  checked={explain}
                  onChange={(e) => setExplain(e.target.checked)}
                />
                🔍 Explain mode — show what happens under the hood (dev)
              </label>
              <Results data={data} loading={loading} error={error} />
              {data?.explain && <UnderTheHood explain={data.explain} />}
            </>
          ) : (
            <ProcurementSearch />
          )}
        </>
      )}
    </div>
  );
}
