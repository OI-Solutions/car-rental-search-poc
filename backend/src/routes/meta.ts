/**
 * GET /api/meta — vehicle classes + cities for the search dropdowns. Protected:
 * requires a valid session like any other authenticated call.
 */
import { Router } from "express";
import { requireAuth } from "../auth/middleware.js";
import { getSearchMeta } from "../services/metaService.js";

export const metaRouter = Router();

metaRouter.get("/", requireAuth, (_req, res) => {
  res.json(getSearchMeta());
});
