/**
 * Development-only session tokens.
 *
 * On login we sign a short-lived JWT carrying the role and tenant associations.
 * All later requests are authorized purely from the verified token claims; the
 * client can never assert its own role/customer/dealership.
 */
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import type { AuthContext, Role, UserRecord } from "../domain/types.js";

interface TokenClaims {
  sub: string;
  role: Role;
  customer_id: string | null;
  dealership_id: string | null;
}

export function signDevToken(user: UserRecord): string {
  const claims: TokenClaims = {
    sub: user.user_id,
    role: user.role,
    customer_id: user.customer_id,
    dealership_id: user.dealership_id,
  };
  return jwt.sign(claims, config.jwtSecret, {
    expiresIn: config.jwtTtlSeconds,
    issuer: "crs-dev",
  });
}

/** Verify a token and return the trusted AuthContext, or throw. */
export function verifyDevToken(token: string): AuthContext {
  const decoded = jwt.verify(token, config.jwtSecret, {
    issuer: "crs-dev",
  }) as TokenClaims;
  return {
    userId: decoded.sub,
    role: decoded.role,
    customerId: decoded.customer_id ?? null,
    dealershipId: decoded.dealership_id ?? null,
  };
}
