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
