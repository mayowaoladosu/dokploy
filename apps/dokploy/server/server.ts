import http from "node:http";
import {
	assertManagedPlatformConfiguration,
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	createReleaseStateMachine,
	IS_CLOUD,
	IS_HOSTED,
	initCancelDeployments,
	initCronJobs,
	initEnterpriseBackupCronJobs,
	initializeNetwork,
	initSchedules,
	initVolumeBackupsCronJobs,
	sendDokployRestartNotifications,
	setupDirectories,
} from "@dokploy/server";
import { config } from "dotenv";
import next from "next";
import packageInfo from "../package.json";
import { setupDockerContainerLogsWebSocketServer } from "./wss/docker-container-logs";
import { setupDockerContainerTerminalWebSocketServer } from "./wss/docker-container-terminal";
import { setupDockerStatsMonitoringSocketServer } from "./wss/docker-stats";
import { setupDrawerLogsWebSocketServer } from "./wss/drawer-logs";
import { setupDeploymentLogsWebSocketServer } from "./wss/listen-deployment";
import { setupTerminalWebSocketServer } from "./wss/terminal";

config({ path: ".env" });
assertManagedPlatformConfiguration();
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";

// Initialize critical directories and Traefik config BEFORE Next.js starts
// This prevents race conditions with the install script
if (process.env.NODE_ENV === "production" && !IS_CLOUD) {
	setupDirectories();
	createDefaultTraefikConfig();
	createDefaultServerTraefikConfig();
	console.log("✅ initialization complete");
}

const app = next({ dev, turbopack: process.env.TURBOPACK === "1" });
const handle = app.getRequestHandler();
void app.prepare().then(async () => {
	try {
		console.log("Running DokployVersion: ", packageInfo.version);
		const server = http.createServer((req, res) => {
			handle(req, res);
		});

		// WEBSOCKET
		setupDrawerLogsWebSocketServer(server);
		setupDeploymentLogsWebSocketServer(server);
		setupDockerContainerLogsWebSocketServer(server);
		setupDockerContainerTerminalWebSocketServer(server);
		setupTerminalWebSocketServer(server);
		if (!IS_HOSTED) {
			setupDockerStatsMonitoringSocketServer(server);
		}

		server.listen(PORT, HOST);
		console.log(`Server Started on: http://${HOST}:${PORT}`);
		if (process.env.NODE_ENV === "production" && !IS_CLOUD) {
			createDefaultMiddlewares();
			await initializeNetwork();
			await initCronJobs();
			await initSchedules();
			await initCancelDeployments();
			await initVolumeBackupsCronJobs();
			await sendDokployRestartNotifications();
		}
		const configuredStaleReleaseTimeoutMs = Number.parseInt(
			process.env.RELEASE_STALE_TIMEOUT_MS || "600000",
			10,
		);
		const staleReleaseTimeoutMs =
			Number.isFinite(configuredStaleReleaseTimeoutMs) &&
			configuredStaleReleaseTimeoutMs > 0
				? configuredStaleReleaseTimeoutMs
				: 600_000;
		const releaseStateMachine = createReleaseStateMachine();
		const reconcileStaleReleases = async () => {
			const reconciledReleaseCount = await releaseStateMachine.reconcileStale(
				new Date(Date.now() - staleReleaseTimeoutMs),
			);
			if (reconciledReleaseCount > 0) {
				console.log(`Reconciled ${reconciledReleaseCount} stale release(s)`);
			}
		};
		await reconcileStaleReleases();
		const releaseReconciliationTimer = setInterval(() => {
			void reconcileStaleReleases().catch((error) =>
				console.error("Failed to reconcile stale releases", error),
			);
		}, 60_000);
		releaseReconciliationTimer.unref();
		await initEnterpriseBackupCronJobs();

		if (!IS_CLOUD) {
			console.log("Starting Deployment Worker");
			const { startDeploymentWorker } = await import("./queues/queueSetup");
			await startDeploymentWorker();
		}
	} catch (e) {
		console.error("Main Server Error", e);
	}
});
