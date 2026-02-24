export type HealthResponse = {
  status: "ok" | "degraded";
  appServerConnected: boolean;
  timestamp: string;
};
