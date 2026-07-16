/**
 * Authentication middleware. Rejects protected requests that lack a valid dev
 * token and, on success, attaches the trusted AuthContext to the request.
 *
 * It also re-checks that the user still exists and is active, so a token issued
 * before deactivation cannot be used.
 */
import type { NextFunction, Request, Response } from "express";
import type { AuthContext } from "../domain/types.js";
import { verifyDevToken } from "./session.js";
import { findUser, isActive } from "./users.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) {
    res.status(401).json({ error: "unauthenticated", message: "Missing bearer token." });
    return;
  }

  let auth: AuthContext;
  try {
    auth = verifyDevToken(match[1]);
  } catch {
    res.status(401).json({ error: "unauthenticated", message: "Invalid or expired token." });
    return;
  }

  const user = findUser(auth.userId);
  if (!user || !isActive(user)) {
    res.status(403).json({ error: "forbidden", message: "User is not active." });
    return;
  }

  req.auth = auth;
  next();
}
