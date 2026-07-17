/**
 * Server bootstrap. LOCAL DEVELOPMENT ONLY.
 */
import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();

app.listen(config.apiPort, () => {
  // Name the retrieval backend honestly: in fixture mode there is no cluster, and
  // printing an OpenSearch URL would imply one is in play.
  const retrieval =
    config.searchBackend === "fixture"
      ? "retrieval: FIXTURE (data/*.json, in-memory)"
      : `OpenSearch: ${config.opensearch.node}`;
  console.log(
    `[crs-backend] DEV API listening on http://localhost:${config.apiPort} ` +
      `(${retrieval}, CORS: ${config.corsOrigin})`,
  );
});
