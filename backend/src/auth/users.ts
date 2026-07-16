/**
 * Synthetic user directory loaded from data/users.json. This is the identity
 * source of truth for the mock authentication flow. No passwords exist or are
 * invented — a user is identified purely by user_id for this POC.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../config.js";
import type { Role, SessionProfile, UserRecord } from "../domain/types.js";
import { customerLabel, dealershipLabel } from "../services/tenantDirectory.js";

const users: UserRecord[] = JSON.parse(
  readFileSync(resolve(DATA_DIR, "users.json"), "utf-8"),
) as UserRecord[];

const usersById = new Map<string, UserRecord>(users.map((u) => [u.user_id, u]));

export function findUser(userId: string): UserRecord | undefined {
  return usersById.get(userId);
}

export function isActive(user: UserRecord): boolean {
  return user.status === "active";
}

const TENANT_TYPE: Record<Role, SessionProfile["tenant_type"]> = {
  customer_user: "customer",
  dealership_user: "dealership",
  corporate_admin: "corporate",
};

/** Build the public, secret-free identity profile shown in the UI. */
export function toProfile(user: UserRecord): SessionProfile {
  const tenantType = TENANT_TYPE[user.role];
  let tenantId: string | null = null;
  let tenantLabel = "Corporate (cross-tenant)";
  if (tenantType === "customer") {
    tenantId = user.customer_id;
    tenantLabel = customerLabel(user.customer_id);
  } else if (tenantType === "dealership") {
    tenantId = user.dealership_id;
    tenantLabel = dealershipLabel(user.dealership_id);
  }
  return {
    user_id: user.user_id,
    role: user.role,
    tenant_type: tenantType,
    tenant_id: tenantId,
    tenant_label: tenantLabel,
  };
}

/** Active users only, for the development identity switcher. */
export function listActiveUsersForSwitcher(): SessionProfile[] {
  return users.filter(isActive).map(toProfile);
}
