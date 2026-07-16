/**
 * Server bootstrap. LOCAL DEVELOPMENT ONLY.
 */
import { createApp } from "./app.js";
import { config } from "./config.js";

const app = createApp();

app.listen(config.apiPort, () => {
  console.log(
    `[crs-backend] DEV API listening on http://localhost:${config.apiPort} ` +
      `(OpenSearch: ${config.opensearch.node}, CORS: ${config.corsOrigin})`,
  );
});
