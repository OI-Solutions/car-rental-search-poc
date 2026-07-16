import { useEffect, useState } from "react";
import type { Role, SessionProfile } from "../types";
import { listUsers } from "../api";

const ROLE_GROUPS: { role: Role; label: string }[] = [
  { role: "customer_user", label: "Customer users" },
  { role: "dealership_user", label: "Dealership users" },
  { role: "corporate_admin", label: "Corporate administrators" },
];

export function UserSwitcher({
  active,
  onSelect,
}: {
  active: SessionProfile | null;
  onSelect: (userId: string) => void;
}) {
  const [users, setUsers] = useState<SessionProfile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listUsers()
      .then(setUsers)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="card">
      <h2>Development identity switcher</h2>
      {error && <div className="state error">Could not load users: {error}</div>}
      <div className="field" style={{ maxWidth: 420 }}>
        <label htmlFor="user">Act as (synthetic user)</label>
        <select
          id="user"
          value={active?.user_id ?? ""}
          onChange={(e) => e.target.value && onSelect(e.target.value)}
        >
          <option value="" disabled>
            Select a user…
          </option>
          {ROLE_GROUPS.map((g) => (
            <optgroup key={g.role} label={g.label}>
              {users
                .filter((u) => u.role === g.role)
                .map((u) => (
                  <option key={u.user_id} value={u.user_id}>
                    {u.user_id} — {u.tenant_label}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>

      {active && (
        <div className="identity" style={{ marginTop: "0.75rem" }}>
          <span>
            <b>Active:</b> {active.user_id}
          </span>
          <span>
            <b>Role:</b> <span className={`pill ${active.tenant_type}`}>{active.role}</span>
          </span>
          <span>
            <b>Tenant:</b> {active.tenant_label}
            {active.tenant_id ? ` (${active.tenant_id})` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
