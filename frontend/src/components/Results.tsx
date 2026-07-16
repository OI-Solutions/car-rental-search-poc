import type { BaseResult, CustomerResult, SearchResponse } from "../types";

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function isCustomer(r: CustomerResult | BaseResult): r is CustomerResult {
  return (r as CustomerResult).effective_daily_rate !== undefined;
}

export function Results({
  data,
  loading,
  error,
}: {
  data: SearchResponse | null;
  loading: boolean;
  error: string | null;
}) {
  if (loading) return <div className="card state">Searching…</div>;
  if (error) return <div className="card state error">Error: {error}</div>;
  if (!data) return <div className="card state muted">Run a search to see results.</div>;
  if (data.count === 0)
    return <div className="card state muted">No matching inventory found.</div>;

  const personalized = data.pricing === "personalized";

  return (
    <div className="card">
      <h2>
        {data.count} result{data.count === 1 ? "" : "s"}{" "}
        <span className="muted" style={{ fontWeight: 400, fontSize: "0.85rem" }}>
          · {personalized ? "personalized pricing" : "base pricing"} · sort: {data.sort}
        </span>
      </h2>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Dealership</th>
              <th>City</th>
              <th>Vehicle</th>
              <th>Class</th>
              <th>Description</th>
              <th className="num">Qty</th>
              <th className="num">Base / day</th>
              {personalized && <th className="num">Your rate / day</th>}
            </tr>
          </thead>
          <tbody>
            {data.results.map((r) => (
              <tr key={r.inventory_id}>
                <td>{r.dealership_name}</td>
                <td>{r.dealership_city}</td>
                <td>
                  {r.make} {r.model}
                </td>
                <td>{r.vehicle_class}</td>
                <td className="muted">{r.description}</td>
                <td className="num">{r.quantity_available}</td>
                <td className="num">{money(r.base_daily_rate)}</td>
                {personalized && isCustomer(r) && (
                  <td className="num">
                    <span className="eff">{money(r.effective_daily_rate)}</span>
                    <br />
                    {r.agreement_applied ? (
                      <span className="applied">−{r.discount_percent}% agreement</span>
                    ) : (
                      <span className="muted" style={{ fontSize: "0.72rem" }}>
                        base rate
                      </span>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
