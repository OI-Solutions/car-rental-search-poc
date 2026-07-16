import type { SearchMeta, SearchRequest, SortOption } from "../types";

const SORTS: { value: SortOption; label: string }[] = [
  { value: "relevance", label: "Relevance" },
  { value: "base_price_asc", label: "Base price (low → high)" },
  { value: "personalized_price_asc", label: "Personalized price (low → high)" },
];

export function SearchControls({
  meta,
  value,
  onChange,
  onSearch,
  onClear,
  loading,
  showPersonalizedSort,
}: {
  meta: SearchMeta | null;
  value: SearchRequest;
  onChange: (next: SearchRequest) => void;
  onSearch: () => void;
  onClear: () => void;
  loading: boolean;
  showPersonalizedSort: boolean;
}) {
  const set = (patch: Partial<SearchRequest>) => onChange({ ...value, ...patch });
  const sorts = SORTS.filter(
    (s) => s.value !== "personalized_price_asc" || showPersonalizedSort,
  );

  return (
    <div className="card">
      <h2>Search</h2>
      <div className="row">
        <div className="field" style={{ flex: "2 1 220px" }}>
          <label htmlFor="q">Text</label>
          <input
            id="q"
            placeholder="e.g. cargo, crew, jobsite…"
            value={value.query ?? ""}
            onChange={(e) => set({ query: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && onSearch()}
          />
        </div>
        <div className="field">
          <label htmlFor="vc">Vehicle class</label>
          <select
            id="vc"
            value={value.vehicle_class ?? ""}
            onChange={(e) => set({ vehicle_class: e.target.value || undefined })}
          >
            <option value="">Any</option>
            {meta?.vehicle_classes.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="city">Dealership city</label>
          <select
            id="city"
            value={value.city ?? ""}
            onChange={(e) => set({ city: e.target.value || undefined })}
          >
            <option value="">Any</option>
            {meta?.cities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sort">Sort</label>
          <select
            id="sort"
            value={value.sort}
            onChange={(e) => set({ sort: e.target.value as SortOption })}
          >
            {sorts.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>&nbsp;</label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="primary" onClick={onSearch} disabled={loading}>
              {loading ? "Searching…" : "Search"}
            </button>
            <button onClick={onClear} disabled={loading}>
              Clear
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
