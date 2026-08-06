// Self-hosted default. The managed Next target aliases this module to
// managed-runtime-root.ts so operator/BYOS routers are absent from the tenant
// API bundle without changing the full AppRouter type used by shared UI code.
export { appRouter as runtimeRouter } from "./root";
