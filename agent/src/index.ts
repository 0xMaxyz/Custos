import { buildServer } from "./server.js";
import { tryLoadConfig } from "./config.js";
import { buildPipeline } from "./pipeline.js";
import { Executor } from "./executor/index.js";
import { Scheduler } from "./scheduler.js";

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

// Wire the autonomous loop when execution prerequisites are configured.
// Graceful read-only mode: if ALLOCATOR_PRIVATE_KEY or VAULT_ADDRESS are absent,
// the scheduler is skipped and the agent serves data-only routes.
if (config.allocatorPrivateKey && config.vaultAddress) {
  const pipeline = buildPipeline(config);
  const executor = new Executor({ config, clients: pipeline.clients, snapshotter: pipeline.snapshotter });
  const scheduler = new Scheduler(executor, {
    onError: (e) => app.log.error({ err: e }, "scheduler cycle error"),
    onCycle: (r) => {
      if (r.submitted) {
        app.log.info({ kind: r.kind, decisionId: r.decisionId?.toString(), txHash: r.txHash }, "decision submitted");
      }
    },
  });

  app.addHook("onReady", async () => {
    scheduler.start();
    app.log.info("autonomous scheduler started (periodic=60m, poll=30s)");
  });

  app.addHook("onClose", async () => {
    scheduler.stop();
  });
} else {
  app.log.warn("ALLOCATOR_PRIVATE_KEY or VAULT_ADDRESS not set — running in read-only mode (no scheduler)");
}

app
  .listen({ port: config.agentPort, host: "0.0.0.0" })
  .then((address) => {
    app.log.info(`sentinel-agent listening on ${address}`);
  })
  .catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
