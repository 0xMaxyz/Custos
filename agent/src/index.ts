import { buildServer } from "./server.js";

const port = Number(process.env.AGENT_PORT ?? 8080);

const app = buildServer();

app
  .listen({ port, host: "0.0.0.0" })
  .then((address) => {
    app.log.info(`sentinel-agent listening on ${address}`);
  })
  .catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
