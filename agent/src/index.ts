import { buildServer } from "./server.js";
import { tryLoadConfig } from "./config.js";

// Validate configuration at startup; fail fast with a readable error.
const result = tryLoadConfig();
if (!result.ok) {
  process.stderr.write(
    `Invalid agent configuration:\n${JSON.stringify(result.error.format(), null, 2)}\n`,
  );
  process.exit(1);
}

const config = result.config;
const app = buildServer();

app
  .listen({ port: config.agentPort, host: "0.0.0.0" })
  .then((address) => {
    app.log.info(`sentinel-agent listening on ${address}`);
  })
  .catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
