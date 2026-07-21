/**
 * "Under the hood" inspector — makes the access-control flow visible with the
 * REAL data from the search you just ran: the controlled query the backend built,
 * the raw → redacted field diff, and the pricing math. Teaching aid only.
 */
import type { ExplainPayload } from "../types";

function Json({ value }: { value: unknown }) {
  return <pre className="hood-json">{JSON.stringify(value, null, 2)}</pre>;
}

export function UnderTheHood({ explain }: { explain: ExplainPayload }) {
  const a = explain.authContext;
  const s = explain.sample;

  return (
    <div className="card hood">
      <h2>
        Under the hood <span className="mock-badge">dev inspector</span>
      </h2>
      <p className="hood-note">⚠ {explain.note}</p>

      <ol className="hood-steps">
        <li>
          <b>Identity the server trusted</b> — derived from the signed token, not the
          request. Everything below is scoped to this.
          <div className="identity" style={{ marginTop: "0.3rem" }}>
            <span><b>role:</b> {a.role}</span>
            <span><b>customerId:</b> {a.customerId ?? "—"}</span>
            <span><b>dealershipId:</b> {a.dealershipId ?? "—"}</span>
          </div>
        </li>

        <li>
          <b>Safe request accepted</b> — only allow-listed business fields.
          <Json value={explain.validatedRequest} />
        </li>

        <li>
          <b>Controlled query the backend built</b> ({explain.inventoryQuery.index}) — the
          client never sends this.{" "}
          {a.role === "dealership_user" && (
            <em>Note the mandatory <code>dealership_id</code> filter injected from the token.</em>
          )}
          <Json value={explain.inventoryQuery.body} />
        </li>

        <li>
          <b>Agreements query</b>{" "}
          {explain.agreementsQuery ? (
            <>
              ({explain.agreementsQuery.index}) — one query per search;{" "}
              <code>customer_id</code> comes from the token.
              <Json value={explain.agreementsQuery.body} />
            </>
          ) : (
            <span className="muted">
              not run — only customer users receive personalized pricing.
            </span>
          )}
        </li>

        {s && (
          <li>
            <b>Redaction — raw retrieval vs. what the client receives.</b> The struck
            fields are dropped by the DTO mapper and never leave the server.
            <div className="hood-diff">
              <div>
                <div className="hood-col-title">Raw candidate (from retrieval)</div>
                <ul className="hood-fields">
                  {Object.entries(s.rawCandidate).map(([k, v]) => {
                    const dropped = s.droppedFields.includes(k);
                    return (
                      <li key={k} className={dropped ? "dropped" : ""}>
                        <code>{k}</code>: {JSON.stringify(v)}
                        {dropped && <span className="drop-tag"> redacted</span>}
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div>
                <div className="hood-col-title">Redacted DTO (returned)</div>
                <Json value={s.redactedResult} />
              </div>
            </div>
          </li>
        )}

        {s?.pricing && (
          <li>
            <b>Pricing math for that item</b> — applied in the app, not OpenSearch.
            <div className="hood-pricing">
              base <b>${s.pricing.base_daily_rate.toFixed(2)}</b> ×{" "}
              (1 − {s.pricing.discount_percent}%) = effective{" "}
              <b>${s.pricing.effective_daily_rate.toFixed(2)}</b>{" "}
              <span className="muted">
                (source: {s.pricing.pricing_source}
                {s.pricing.agreement_applied ? ", agreement applied" : ""})
              </span>
            </div>
          </li>
        )}
      </ol>

      <details className="hood-scale">
        <summary>
          Why is retrieval <b>denormalized</b>, not parent/child? <span className="muted">(scale note)</span>
        </summary>
        <div className="hood-scale-body">
          <p className="hood-note" style={{ marginTop: "0.5rem" }}>
            This inspector runs on the small demo corpus. The modeling choice behind it
            was measured on a <b>2,000,000-row</b> local benchmark: the same query and the
            same results, stored two ways.
          </p>
          <table className="hood-scale-table">
            <thead>
              <tr><th>filter</th><th>rows</th><th>flat</th><th>join</th><th>join÷flat</th></tr>
            </thead>
            <tbody>
              <tr><td>all inventory</td><td>2,000,000</td><td>0.8 ms</td><td>1.0 ms</td><td>1.2×</td></tr>
              <tr className="hi"><td>+ class=suv</td><td>611,042</td><td>1.0 ms</td><td>13.5 ms</td><td>13.5×</td></tr>
              <tr><td>+ city</td><td>19,599</td><td>2.0 ms</td><td>2.4 ms</td><td>1.2×</td></tr>
              <tr><td>+ price ≤ 80</td><td>10,586</td><td>2.0 ms</td><td>2.7 ms</td><td>1.4×</td></tr>
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: "0.82rem", lineHeight: 1.5 }}>
            Filters prune ~99.5% of the space, so search over millions stays fast either
            way. But a broad filter on a <b>model attribute</b> (<code>class=suv</code>)
            forces the parent/child model to resolve parent→child across all 611k matches
            — <b>13.5× slower</b>. The flat index answers it as one <code>term</code>.
            Denormalization pays for that read speed in storage (<b>+32%</b>: 517 vs 391 MB),
            a bill this read-heavy, static-model workload is happy to pay. Full method:{" "}
            <code>docs/SCALE_AND_JOINS.md</code>.
          </p>
        </div>
      </details>
    </div>
  );
}
