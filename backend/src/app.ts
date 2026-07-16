/**
 * Express application factory. Kept separate from the server bootstrap so tests
 * can import the app without opening a listening socket.
 */
import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { devSessionRouter } from "./routes/devSession.js";
import { searchRouter } from "./routes/search.js";
import { metaRouter } from "./routes/meta.js";

export function createApp() {
  const app = express();

  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: "16kb" }));

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

  // DEVELOPMENT-ONLY mock identity endpoints.
  app.use("/api/dev", devSessionRouter);

  // Protected endpoints.
  app.use("/api/meta", metaRouter);
  app.use("/api/search", searchRouter);

  // Safe fallback error handler (no stack traces to clients).
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      console.error("unhandled error:", err);
      res.status(500).json({ error: "internal_error", message: "Unexpected server error." });
    },
  );

  return app;
}
