/**
 * POST /api/search — the protected personalized search endpoint.
 *
 * Auth is enforced by requireAuth. Inputs are validated to safe domain fields
 * only; any client-supplied customer_id / dealership_id / raw DSL is rejected by
 * the strict schema (or simply ignored, never trusted). The AuthContext comes
 * exclusively from the verified token.
 */
import { Router } from "express";
import { ZodError } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { parseSearchParams } from "../validation/searchSchema.js";
import { runProtectedSearch } from "../services/protectedSearch.js";

export const searchRouter = Router();

searchRouter.post("/", requireAuth, async (req, res) => {
  let params;
  try {
    params = parseSearchParams(req.body ?? {});
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: "invalid_request",
        message: "Unsupported or malformed search parameters.",
        issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return;
    }
    throw err;
  }

  try {
    // req.auth is guaranteed by requireAuth.
    const response = await runProtectedSearch(req.auth!, params);
    res.json(response);
  } catch (err) {
    // Never leak OpenSearch internals / stack traces to the client.
    console.error("search failed:", err);
    res.status(502).json({ error: "search_failed", message: "Upstream search error." });
  }
});
