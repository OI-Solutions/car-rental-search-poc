import { useState } from "react";
import {
  buildMockAllocation,
  OBJECTIVES,
  REGIONS,
  VEHICLE_CLASSES,
  type AllocationPlan,
  type Objective,
  type ProcurementForm,
  type VehicleClass,
} from "../procurementMock";

const DEFAULT_FORM: ProcurementForm = {
  vehicleClass: "suv",
  totalQuantity: 12,
  regions: ["chicago_metro", "north_nw", "west", "southwest"],
  maxDailyRate: null,
  objective: "lowest_total_cost",
  allowSplit: true,
  contractedOnly: false,
};

const money = (n: number) => `$${n.toFixed(2)}`;

function ArchitectureFlow() {
  const steps = [
    "Procurement request",
    "Regional + inventory filtering in OpenSearch",
    "Customer-specific pricing in the application layer",
    "Future allocation / optimization service",
    "Sourcing plan",
  ];
  return (
    <details className="flow-details">
      <summary>How this would work (concept architecture)</summary>
      <div className="flow">
        {steps.map((s, i) => (
          <div className="flow-step" key={s}>
            <span className="flow-box">{s}</span>
            {i < steps.length - 1 && <span className="flow-arrow">→</span>}
          </div>
        ))}
      </div>
      <p className="muted flow-note">
        The first two stages reuse today's implemented pipeline (controlled OpenSearch
        retrieval + application-layer pricing). Only the allocation/optimization stage
        is new and unbuilt.
      </p>
    </details>
  );
}

function SummaryCards({ plan }: { plan: AllocationPlan }) {
  const s = plan.summary;
  const cards: { label: string; value: string; warn?: boolean }[] = [
    { label: "Total requested", value: String(s.totalRequested) },
    { label: "Total fulfilled", value: String(s.totalFulfilled) },
    { label: "Dealerships used", value: String(s.dealershipsUsed) },
    { label: "Est. total daily cost", value: money(s.estimatedTotalDailyCost) },
    { label: "Avg. personalized rate", value: money(s.averagePersonalizedRate) },
    { label: "Unmet demand", value: String(s.unmetDemand), warn: s.unmetDemand > 0 },
  ];
  return (
    <div className="summary-grid">
      {cards.map((c) => (
        <div className={`stat ${c.warn ? "stat-warn" : ""}`} key={c.label}>
          <div className="stat-value">{c.value}</div>
          <div className="stat-label">{c.label}</div>
        </div>
      ))}
    </div>
  );
}

export function ProcurementSearch() {
  const [form, setForm] = useState<ProcurementForm>(DEFAULT_FORM);
  const [plan, setPlan] = useState<AllocationPlan | null>(null);

  const set = (patch: Partial<ProcurementForm>) => setForm({ ...form, ...patch });
  const toggleRegion = (id: string) =>
    set({
      regions: form.regions.includes(id)
        ? form.regions.filter((r) => r !== id)
        : [...form.regions, id],
    });

  function handlePlan() {
    setPlan(buildMockAllocation(form));
  }
  function handleClear() {
    setForm(DEFAULT_FORM);
    setPlan(null);
  }

  return (
    <>
      <div className="card">
        <div className="mock-head">
          <h2 style={{ margin: 0 }}>Procurement Search</h2>
          <span className="mock-badge">Future procurement workflow — mock data</span>
        </div>
        <p className="callout">
          Procurement mode changes the problem from <b>ranking individual search
          results</b> to <b>allocating demand across locations</b>. OpenSearch would
          retrieve eligible inventory candidates; the application would apply
          customer-specific pricing; a future allocation service would construct the
          sourcing plan.
        </p>
        <ArchitectureFlow />

        <div className="row" style={{ marginTop: "0.75rem" }}>
          <div className="field">
            <label htmlFor="p-vc">Vehicle class</label>
            <select
              id="p-vc"
              value={form.vehicleClass}
              onChange={(e) => set({ vehicleClass: e.target.value as VehicleClass })}
            >
              {VEHICLE_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="p-qty">Total quantity required</label>
            <input
              id="p-qty"
              type="number"
              min={1}
              style={{ width: 130 }}
              value={form.totalQuantity}
              onChange={(e) => set({ totalQuantity: Math.max(1, Number(e.target.value) || 1) })}
            />
          </div>
          <div className="field">
            <label htmlFor="p-max">Max daily rate (optional)</label>
            <input
              id="p-max"
              type="number"
              min={0}
              placeholder="none"
              style={{ width: 130 }}
              value={form.maxDailyRate ?? ""}
              onChange={(e) =>
                set({ maxDailyRate: e.target.value === "" ? null : Number(e.target.value) })
              }
            />
          </div>
          <div className="field">
            <label htmlFor="p-obj">Optimization objective</label>
            <select
              id="p-obj"
              value={form.objective}
              onChange={(e) => set({ objective: e.target.value as Objective })}
            >
              {OBJECTIVES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="field" style={{ marginTop: "0.75rem" }}>
          <label>Regions</label>
          <div className="checks">
            {REGIONS.map((r) => (
              <label key={r.id} className="check">
                <input
                  type="checkbox"
                  checked={form.regions.includes(r.id)}
                  onChange={() => toggleRegion(r.id)}
                />
                {r.label}
              </label>
            ))}
          </div>
        </div>

        <div className="row" style={{ marginTop: "0.75rem", alignItems: "center" }}>
          <label className="check">
            <input
              type="checkbox"
              checked={form.allowSplit}
              onChange={(e) => set({ allowSplit: e.target.checked })}
            />
            Allow split fulfillment across dealerships
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={form.contractedOnly}
              onChange={(e) => set({ contractedOnly: e.target.checked })}
            />
            Contracted dealerships only
          </label>
          <div style={{ display: "flex", gap: "0.5rem", marginLeft: "auto" }}>
            <button className="primary" onClick={handlePlan} disabled={form.regions.length === 0}>
              Plan Fleet
            </button>
            <button onClick={handleClear}>Clear</button>
          </div>
        </div>
        {form.regions.length === 0 && (
          <p className="muted" style={{ marginBottom: 0 }}>Select at least one region.</p>
        )}
      </div>

      {plan && (
        <div className="card">
          <h2>
            Sourcing plan{" "}
            <span className="mock-badge" style={{ verticalAlign: "middle" }}>
              mock allocation
            </span>
          </h2>
          <SummaryCards plan={plan} />
          {plan.notes.length > 0 && (
            <ul className="notes">
              {plan.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Region</th>
                  <th>Dealership</th>
                  <th>Class</th>
                  <th className="num">Qty</th>
                  <th className="num">Base / day</th>
                  <th className="num">Personalized / day</th>
                  <th className="num">Est. subtotal</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {plan.rows.map((r, i) => (
                  <tr key={`${r.dealership}-${i}`}>
                    <td>{r.region}</td>
                    <td>{r.dealership}</td>
                    <td>{r.vehicleClass}</td>
                    <td className="num">{r.quantity}</td>
                    <td className="num">{r.baseDailyRate ? money(r.baseDailyRate) : "—"}</td>
                    <td className="num eff">
                      {r.personalizedDailyRate ? money(r.personalizedDailyRate) : "—"}
                    </td>
                    <td className="num">{r.estimatedSubtotal ? money(r.estimatedSubtotal) : "—"}</td>
                    <td>
                      <span className={`status status-${r.status.toLowerCase()}`}>{r.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{ marginBottom: 0, fontSize: "0.8rem" }}>
            Illustrative values only — no live inventory, pricing, or optimization was run.
          </p>
        </div>
      )}
    </>
  );
}
