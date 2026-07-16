/**
 * DEVELOPMENT-ONLY identity routes.
 *
 * POST /api/dev/session  -> mint a signed dev token for an existing ACTIVE user.
 * GET  /api/dev/users    -> list active users for the frontend identity switcher.
 *
 * There is no password check by design: this is a mock auth flow over synthetic
 * users. It must never be shipped as real authentication.
 */
import { Router } from "express";
import { z } from "zod";
import { findUser, isActive, listActiveUsersForSwitcher, toProfile } from "../auth/users.js";
import { signDevToken } from "../auth/session.js";

const sessionSchema = z.object({ user_id: z.string().trim().min(1).max(40) }).strict();

export const devSessionRouter = Router();

devSessionRouter.get("/users", (_req, res) => {
  res.json({ users: listActiveUsersForSwitcher() });
});

devSessionRouter.post("/session", (req, res) => {
  const parsed = sessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", message: "Expected { user_id }." });
    return;
  }

  const user = findUser(parsed.data.user_id);
  if (!user) {
    res.status(404).json({ error: "not_found", message: "Unknown user." });
    return;
  }
  if (!isActive(user)) {
    res.status(403).json({ error: "inactive_user", message: "User is not active." });
    return;
  }

  const token = signDevToken(user);
  res.json({ token, profile: toProfile(user) });
});
