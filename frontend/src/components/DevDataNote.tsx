/**
 * Expandable summary of the synthetic dataset behind the POC. Purely
 * informational — shown inside the development-only banner so it's clear the
 * whole demo runs on generated, deterministic data.
 */
export function DevDataNote() {
  return (
    <details className="devdata">
      <summary>What synthetic data is behind this?</summary>
      <div className="devdata-body">
        <p style={{ marginTop: "0.5rem" }}>
          A small, deterministic dataset (fixed seed) modeling a B2B rental network
          around Chicago, Illinois. No real people, companies, or credentials.
        </p>
        <ul>
          <li>
            <b>5 dealerships</b> (Illinois): Chicago Central Fleet, Plainfield
            Business Rentals, Naperville Commercial Auto, Joliet Jobsite Vehicles,
            Schaumburg Corporate Mobility — each with a geo-located branch.
          </li>
          <li>
            <b>5 vehicle models / classes</b>: compact_sedan (Toyota Corolla),
            midsize_sedan (Honda Accord), suv (Ford Explorer), pickup_truck (Ford
            F-150), cargo_van (Ram ProMaster 2500).
          </li>
          <li>
            <b>50 inventory records</b> — two per class per dealership, each with a
            base daily rate, quantity, and status (<code>available</code> /{" "}
            <code>limited</code>).
          </li>
          <li>
            <b>12 business customers</b> across industries (electrical, HVAC, medical
            logistics, construction, …); one is <code>inactive</code>.
          </li>
          <li>
            <b>36 discount agreements</b> — 2–4 per customer, negotiated per
            dealership, some specific to a vehicle class, discounts ~4–28%. These
            drive the personalized pricing.
          </li>
          <li>
            <b>19 mock users</b> — 12 customer, 5 dealership, 2 corporate. Used only
            for the identity switcher; <b>never indexed</b>, and no passwords exist.
          </li>
        </ul>
        <p className="muted" style={{ marginBottom: 0 }}>
          Inventory and agreements are indexed in OpenSearch; users are not. Pricing
          in Basic Search is computed live from these agreements.
        </p>
      </div>
    </details>
  );
}
