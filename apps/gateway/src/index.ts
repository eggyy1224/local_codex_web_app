// MUST be first: loads apps/gateway/.env before any import that reads
// process.env at module-init time (e.g. db.ts createGatewayDb()).
import "./loadEnv.js";
import { AppServerClient } from "./appServerClient.js";
import {
  createGatewayApp,
  createGatewayBootstrapConfigFromEnv,
} from "./gatewayApp.js";

const bootstrap = createGatewayBootstrapConfigFromEnv(process.env);
const app = await createGatewayApp(
  {
    appServer: new AppServerClient(),
  },
  bootstrap.app,
);

await app.listen({ host: bootstrap.host, port: bootstrap.port });
