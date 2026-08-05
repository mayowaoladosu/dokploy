import http from "node:http";
import {
	assertManagedPlatformConfiguration,
	configureManagedDataProviderFromEnvironment,
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	createReleaseStateMachine,
	IS_CLOUD,
	IS_HOSTED,
	IS_MANAGED_PAAS,
	initCancelDeployments,
	initCronJobs,
	initEnterpriseBackupCronJobs,
	initializeNetwork,
	initSchedules,
	initVolumeBackupsCronJobs,
	reconcileDomainVerifications,
	reconcileKubernetesPlacements,
	sendDokployRestartNotifications,
	setupDirectories,
} from "@dokploy/server";
import { config } from "dotenv";
import next from "next";
import packageInfo from "../package.json";
import { closeTemporalClient } from "./temporal/client";
import { temporalConfiguration } from "./temporal/config";
import { startTemporalWorker, stopTemporalWorker } from "./temporal/worker";
import { setupDockerContainerLogsWebSocketServer } from "./wss/docker-container-logs";
import { setupDockerContainerTerminalWebSocketServer } from "./wss/docker-container-terminal";
import { setupDockerStatsMonitoringSocketServer } from "./wss/docker-stats";
import { setupDrawerLogsWebSocketServer } from "./wss/drawer-logs";
import { setupDeploymentLogsWebSocketServer } from "./wss/listen-deployment";
import { setupTerminalWebSocketServer } from "./wss/terminal";

config({ path: ".env" });
assertManagedPlatformConfiguration();
if (IS_MANAGED_PAAS && !temporalConfiguration().enabled) {
	throw new Error(
		"Managed mode requires TEMPORAL_ENABLED=true and a configured Temporal service",
	);
}
configureManagedDataProviderFromEnvironment();
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
		const timers: NodeJS.Timeout[] = [];
		let shuttingDown = false;
		const shutdown = async (signal: NodeJS.Signals) => {
			if (shuttingDown) return;
			shuttingDown = true;
			console.log(`Received ${signal}; shutting down gracefully`);
			for (const timer of timers) clearInterval(timer);

			const httpClosed = new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			});
			const queueClosed = !IS_CLOUD
				? import("./queues/queueSetup").then(({ closeDeploymentQueue }) =>
						closeDeploymentQueue(),
					)
				: Promise.resolve();
			const results = await Promise.allSettled([
				httpClosed,
				queueClosed,
				stopTemporalWorker(),
				closeTemporalClient(),
				app.close(),
			]);
			const failures = results.filter(
				(result): result is PromiseRejectedResult =>
					result.status === "rejected",
			);
			for (const failure of failures) {
				console.error("Graceful shutdown step failed", failure.reason);
			}
			process.exitCode = failures.length > 0 ? 1 : 0;
		};
		process.once("SIGTERM", () => void shutdown("SIGTERM"));
		process.once("SIGINT", () => void shutdown("SIGINT"));

		// WEBSOCKET
		setupDrawerLogsWebSocketServer(server);
		setupDeploymentLogsWebSocketServer(server);
		setupDockerContainerLogsWebSocketServer(server);
		setupDockerContainerTerminalWebSocketServer(server);
		setupTerminalWebSocketServer(server);
		if (!IS_HOSTED) {
			setupDockerStatsMonitoringSocketServer(server);
		}

		if (temporalConfiguration().enabled) {
			await startTemporalWorker();
			console.log("Temporal deployment worker started");
		}
		server.listen(PORT, HOST);
		console.log(`Server Started on: http://${HOST}:${PORT}`);
		const reconciledDomains = await reconcileDomainVerifications();
		if (reconciledDomains > 0) {
			console.log(`Initialized ${reconciledDomains} domain verification(s)`);
		}
		const reconcilePlacements = async () => {
			const result = await reconcileKubernetesPlacements();
			if (result.active + result.pending + result.failed > 0) {
				console.log(
					`Reconciled Kubernetes placements: ${result.active} active, ${result.pending} pending, ${result.failed} failed`,
				);
			}
		};
		await reconcilePlacements();
		const placementReconciliationTimer = setInterval(() => {
			void reconcilePlacements().catch((error) =>
				console.error("Failed to reconcile Kubernetes placements", error),
			);
		}, 60_000);
		placementReconciliationTimer.unref();
		timers.push(placementReconciliationTimer);
		if (process.env.NODE_ENV === "production" && !IS_CLOUD) {
			createDefaultMiddlewares();
			await initializeNetwork();
			await initCronJobs();
			await initSchedules();
			await initCancelDeployments();
			await initVolumeBackupsCronJobs();
			await sendDokployRestartNotifications();
		}
		const temporalEnabled = temporalConfiguration().enabled;
		const defaultStaleReleaseTimeoutMs = temporalEnabled
			? 4 * 60 * 60 * 1_000
			: 600_000;
		const configuredStaleReleaseTimeoutMs = Number.parseInt(
			process.env.RELEASE_STALE_TIMEOUT_MS ||
				String(defaultStaleReleaseTimeoutMs),
			10,
		);
		const staleReleaseTimeoutMs =
			Number.isFinite(configuredStaleReleaseTimeoutMs) &&
			configuredStaleReleaseTimeoutMs > 0
				? configuredStaleReleaseTimeoutMs
				: defaultStaleReleaseTimeoutMs;
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
		timers.push(releaseReconciliationTimer);
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
