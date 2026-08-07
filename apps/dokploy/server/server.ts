import http from "node:http";
import {
	assertManagedDataBackupPlatformReadiness,
	assertManagedPlatformConfiguration,
	bootstrapManagedPlatformFromEnvironment,
	configureFirstPartyManagedDataProvidersFromEnvironment,
	configureManagedDataProviderFromEnvironment,
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	createPolarEventClient,
	createReleaseStateMachine,
	handleHttpRequestWithTelemetry,
	IS_CLOUD,
	IS_HOSTED,
	IS_MANAGED_PAAS,
	initCancelDeployments,
	initCronJobs,
	initEnterpriseBackupCronJobs,
	initializeNetwork,
	initializeOpenTelemetry,
	initSchedules,
	initVolumeBackupsCronJobs,
	listRegisteredManagedDataProviders,
	loadPlatformManagedDataProviders,
	reconcileCloudflareEdgeUsage,
	reconcileDomainVerifications,
	reconcileExpiredPreviewDeployments,
	reconcileKubernetesPlacements,
	reconcileManagedBillingSuspensions,
	reconcileManagedDataBackups,
	reconcileManagedDataResources,
	reconcileManagedDataUsage,
	reconcilePlatformObservabilityCollectors,
	reconcileStaticStorageUsage,
	sendDokployRestartNotifications,
	setupDirectories,
	shutdownOpenTelemetry,
	synchronizeManagedDataBindingSecrets,
	synchronizePolarUsage,
	verifyRegisteredManagedDataProviders,
} from "@dokploy/server";
import { config } from "dotenv";
import next from "next";
import packageInfo from "../package.json";
import { reconcileGitDelivery } from "./git-delivery";
import { closeTemporalClient } from "./temporal/client";
import { temporalConfiguration } from "./temporal/config";
import { startTemporalWorker, stopTemporalWorker } from "./temporal/worker";
import {
	assertPolarConfiguration,
	getPolarClient,
	polarAccessToken,
	polarEnvironment,
	reconcilePolarCustomerStates,
	verifyPolarConfiguration,
} from "./utils/polar";
import { setupDrawerLogsWebSocketServer } from "./wss/drawer-logs";
import { setupDeploymentLogsWebSocketServer } from "./wss/listen-deployment";

config({ path: ".env" });
const telemetry = initializeOpenTelemetry();
if (telemetry.enabled) {
	console.log(
		`OpenTelemetry initialized for ${telemetry.configuration.serviceName}`,
	);
}
assertManagedPlatformConfiguration();
assertPolarConfiguration();
if (IS_MANAGED_PAAS && !temporalConfiguration().enabled) {
	throw new Error(
		"Managed mode requires TEMPORAL_ENABLED=true and a configured Temporal service",
	);
}
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
	let shutdownAfterStart:
		| ((signal: NodeJS.Signals) => Promise<void>)
		| undefined;
	try {
		console.log("Running DokployVersion: ", packageInfo.version);
		await verifyPolarConfiguration();
		const bootstrap = await bootstrapManagedPlatformFromEnvironment();
		if (bootstrap.enabled) {
			console.log(
				`Managed platform bootstrap reconciled cluster ${bootstrap.clusterId}${bootstrap.activated ? " and activated infrastructure" : " in provisioning mode"}`,
			);
		}
		const databaseProviderCount = await loadPlatformManagedDataProviders();
		const firstPartyProviderCount =
			configureFirstPartyManagedDataProvidersFromEnvironment();
		const genericProvider = configureManagedDataProviderFromEnvironment();
		if (
			IS_MANAGED_PAAS &&
			databaseProviderCount + firstPartyProviderCount === 0 &&
			!genericProvider
		) {
			throw new Error("Managed mode requires an active managed data provider");
		}
		await verifyRegisteredManagedDataProviders();
		if (IS_MANAGED_PAAS) {
			await assertManagedDataBackupPlatformReadiness();
			const observability = await reconcilePlatformObservabilityCollectors();
			if (observability.failed > 0 || observability.active === 0) {
				throw new Error(
					`Managed observability is not ready (${observability.active} active, ${observability.failed} failed, ${observability.skipped} skipped)`,
				);
			}
		}
		console.log(
			`Managed data providers active: ${listRegisteredManagedDataProviders()
				.map((provider) => provider.name)
				.join(", ")}`,
		);
		const server = http.createServer((req, res) => {
			void handleHttpRequestWithTelemetry(req, res, async () => {
				await handle(req, res);
			}).catch((error) => {
				console.error("HTTP request failed", error);
				if (!res.headersSent) {
					res.statusCode = 500;
					res.end("Internal Server Error");
				}
			});
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
				shutdownOpenTelemetry(),
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
		shutdownAfterStart = shutdown;
		process.once("SIGTERM", () => void shutdown("SIGTERM"));
		process.once("SIGINT", () => void shutdown("SIGINT"));

		// WEBSOCKET
		setupDrawerLogsWebSocketServer(server);
		setupDeploymentLogsWebSocketServer(server);
		if (!IS_MANAGED_PAAS && process.env.DOKPLOY_BUILD_TARGET !== "managed") {
			const [containerLogs, containerTerminal, hostTerminal] =
				await Promise.all([
					import("./wss/docker-container-logs"),
					import("./wss/docker-container-terminal"),
					import("./wss/terminal"),
				]);
			containerLogs.setupDockerContainerLogsWebSocketServer(server);
			containerTerminal.setupDockerContainerTerminalWebSocketServer(server);
			hostTerminal.setupTerminalWebSocketServer(server);
			if (!IS_HOSTED) {
				const { setupDockerStatsMonitoringSocketServer } = await import(
					"./wss/docker-stats"
				);
				setupDockerStatsMonitoringSocketServer(server);
			}
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
			if (IS_MANAGED_PAAS) {
				const billing = await reconcileManagedBillingSuspensions();
				if (billing.suspended + billing.resumed + billing.failed > 0) {
					console.log(
						`Reconciled billing suspensions: ${billing.suspended} suspended, ${billing.resumed} resumed, ${billing.failed} failed`,
					);
				}
			}
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
		let gitDeliveryReconciliationRunning = false;
		const reconcileGitDeliveries = async () => {
			if (gitDeliveryReconciliationRunning) return;
			gitDeliveryReconciliationRunning = true;
			try {
				const result = await reconcileGitDelivery();
				if (
					result.stateReconciled +
						result.enqueued +
						result.reported +
						result.failed >
					0
				) {
					console.log(
						`Reconciled Git delivery: ${result.enqueued} enqueued, ${result.stateReconciled} terminal, ${result.reported} reported, ${result.failed} failed`,
					);
				}
			} finally {
				gitDeliveryReconciliationRunning = false;
			}
		};
		await reconcileGitDeliveries().catch((error) =>
			console.error("Failed to reconcile Git delivery", error),
		);
		const gitDeliveryTimer = setInterval(() => {
			void reconcileGitDeliveries().catch((error) =>
				console.error("Failed to reconcile Git delivery", error),
			);
		}, 30_000);
		gitDeliveryTimer.unref();
		timers.push(gitDeliveryTimer);

		const expirePreviews = async () => {
			const { cleanQueuesByPreviewDeployment } = await import(
				"./queues/queueSetup"
			);
			const result = await reconcileExpiredPreviewDeployments(
				new Date(),
				50,
				(previewDeploymentId) =>
					cleanQueuesByPreviewDeployment(previewDeploymentId, {
						waitForCompletion: true,
					}).then(() => undefined),
			);
			if (result.expired + result.failed > 0) {
				console.log(
					`Reconciled preview expiry: ${result.expired} expired, ${result.failed} failed`,
				);
			}
		};
		await expirePreviews().catch((error) =>
			console.error("Failed to reconcile preview expiry", error),
		);
		const previewExpiryTimer = setInterval(() => {
			void expirePreviews().catch((error) =>
				console.error("Failed to reconcile preview expiry", error),
			);
		}, 5 * 60_000);
		previewExpiryTimer.unref();
		timers.push(previewExpiryTimer);
		if (IS_MANAGED_PAAS) {
			let managedDataLifecycleRunning = false;
			const reconcileDatabaseLifecycle = async () => {
				if (managedDataLifecycleRunning) return;
				managedDataLifecycleRunning = true;
				try {
					const result = await reconcileManagedDataResources();
					const synchronized = await synchronizeManagedDataBindingSecrets();
					if (result.reconciled + result.failed + synchronized > 0) {
						console.log(
							`Reconciled managed data lifecycle: ${result.reconciled} resources, ${synchronized} credential rollout(s), ${result.failed} failed`,
						);
					}
				} finally {
					managedDataLifecycleRunning = false;
				}
			};
			await reconcileDatabaseLifecycle().catch((error) =>
				console.error("Failed to reconcile managed data lifecycle", error),
			);
			const managedDataLifecycleTimer = setInterval(() => {
				void reconcileDatabaseLifecycle().catch((error) =>
					console.error("Failed to reconcile managed data lifecycle", error),
				);
			}, 60_000);
			managedDataLifecycleTimer.unref();
			timers.push(managedDataLifecycleTimer);
			const providerHealthTimer = setInterval(() => {
				void (async () => {
					await loadPlatformManagedDataProviders();
					configureFirstPartyManagedDataProvidersFromEnvironment();
					configureManagedDataProviderFromEnvironment();
					await verifyRegisteredManagedDataProviders();
				})().catch((error) =>
					console.error("Managed data provider reload failed", error),
				);
			}, 5 * 60_000);
			providerHealthTimer.unref();
			timers.push(providerHealthTimer);
			let edgeUsageReconciliationRunning = false;
			const reconcileEdgeUsage = async () => {
				if (edgeUsageReconciliationRunning) return;
				edgeUsageReconciliationRunning = true;
				try {
					const reconciled = await reconcileCloudflareEdgeUsage();
					if (reconciled > 0) {
						console.log(
							`Reconciled Cloudflare usage for ${reconciled} hostname(s)`,
						);
					}
				} finally {
					edgeUsageReconciliationRunning = false;
				}
			};
			await reconcileEdgeUsage().catch((error) =>
				console.error("Failed to reconcile Cloudflare usage", error),
			);
			const edgeUsageTimer = setInterval(() => {
				void reconcileEdgeUsage().catch((error) =>
					console.error("Failed to reconcile Cloudflare usage", error),
				);
			}, 5 * 60_000);
			edgeUsageTimer.unref();
			timers.push(edgeUsageTimer);
			const reconcileStorageUsage = async () => {
				const reconciled = await reconcileStaticStorageUsage();
				if (reconciled > 0) {
					console.log(
						`Reconciled static storage usage for ${reconciled} publication(s)`,
					);
				}
			};
			await reconcileStorageUsage().catch((error) =>
				console.error("Failed to reconcile static storage usage", error),
			);
			const storageUsageTimer = setInterval(() => {
				void reconcileStorageUsage().catch((error) =>
					console.error("Failed to reconcile static storage usage", error),
				);
			}, 15 * 60_000);
			storageUsageTimer.unref();
			timers.push(storageUsageTimer);
			let managedDataUsageRunning = false;
			const reconcileDatabaseUsage = async () => {
				if (managedDataUsageRunning) return;
				managedDataUsageRunning = true;
				try {
					const result = await reconcileManagedDataUsage();
					if (result.reconciled + result.failed > 0) {
						console.log(
							`Reconciled managed data usage: ${result.reconciled} succeeded, ${result.failed} failed`,
						);
					}
				} finally {
					managedDataUsageRunning = false;
				}
			};
			await reconcileDatabaseUsage().catch((error) =>
				console.error("Failed to reconcile managed data usage", error),
			);
			const managedDataUsageTimer = setInterval(() => {
				void reconcileDatabaseUsage().catch((error) =>
					console.error("Failed to reconcile managed data usage", error),
				);
			}, 15 * 60_000);
			managedDataUsageTimer.unref();
			timers.push(managedDataUsageTimer);
			let managedDataBackupRunning = false;
			const reconcileDatabaseBackups = async () => {
				if (managedDataBackupRunning) return;
				managedDataBackupRunning = true;
				try {
					const result = await reconcileManagedDataBackups();
					if (
						result.created + result.refreshed + result.deleted + result.failed >
						0
					) {
						console.log(
							`Reconciled managed data backups: ${result.created} created, ${result.refreshed} refreshed, ${result.deleted} expired, ${result.failed} failed`,
						);
					}
				} finally {
					managedDataBackupRunning = false;
				}
			};
			await reconcileDatabaseBackups().catch((error) =>
				console.error("Failed to reconcile managed data backups", error),
			);
			const managedDataBackupTimer = setInterval(() => {
				void reconcileDatabaseBackups().catch((error) =>
					console.error("Failed to reconcile managed data backups", error),
				);
			}, 60_000);
			managedDataBackupTimer.unref();
			timers.push(managedDataBackupTimer);

			const reconcileObservability = async () => {
				const result = await reconcilePlatformObservabilityCollectors();
				if (result.active + result.failed > 0) {
					console.log(
						`Reconciled observability collectors: ${result.active} active, ${result.failed} failed`,
					);
				}
			};
			await reconcileObservability().catch((error) =>
				console.error("Failed to reconcile observability collectors", error),
			);
			const observabilityTimer = setInterval(() => {
				void reconcileObservability().catch((error) =>
					console.error("Failed to reconcile observability collectors", error),
				);
			}, 5 * 60_000);
			observabilityTimer.unref();
			timers.push(observabilityTimer);

			const polarToken = process.env.POLAR_ACCESS_TOKEN?.trim();
			if (polarToken) {
				const polar = getPolarClient();
				let polarStateRunning = false;
				const reconcilePolarState = async () => {
					if (polarStateRunning) return;
					polarStateRunning = true;
					try {
						const result = await reconcilePolarCustomerStates(polar);
						if (result.failed > 0) {
							console.error(
								`Polar state reconciliation failed for ${result.failed} organization(s)`,
							);
						}
					} finally {
						polarStateRunning = false;
					}
				};
				await reconcilePolarState();
				const polarStateTimer = setInterval(() => {
					void reconcilePolarState().catch((error) =>
						console.error("Failed to reconcile Polar customer states", error),
					);
				}, 60 * 60_000);
				polarStateTimer.unref();
				timers.push(polarStateTimer);
				const polarUsageClient = createPolarEventClient({
					accessToken: polarAccessToken(),
					environment: polarEnvironment(),
				});
				let polarUsageRunning = false;
				const synchronizeUsage = async () => {
					if (polarUsageRunning) return;
					polarUsageRunning = true;
					try {
						const result = await synchronizePolarUsage({
							client: polarUsageClient,
						});
						if (result.attempted > 0) {
							console.log(
								`Exported Polar usage: ${result.delivered} delivered, ${result.failed} failed`,
							);
						}
					} finally {
						polarUsageRunning = false;
					}
				};
				await synchronizeUsage().catch((error) =>
					console.error("Failed to export Polar usage", error),
				);
				const polarUsageTimer = setInterval(() => {
					void synchronizeUsage().catch((error) =>
						console.error("Failed to export Polar usage", error),
					);
				}, 5 * 60_000);
				polarUsageTimer.unref();
				timers.push(polarUsageTimer);
			}
		}
		if (
			process.env.NODE_ENV === "production" &&
			!IS_CLOUD &&
			!IS_MANAGED_PAAS
		) {
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
		if (!IS_MANAGED_PAAS) {
			await initEnterpriseBackupCronJobs();
		}

		if (!IS_CLOUD && !IS_MANAGED_PAAS) {
			console.log("Starting Deployment Worker");
			const { startDeploymentWorker } = await import("./queues/queueSetup");
			await startDeploymentWorker();
		}
	} catch (e) {
		console.error("Main Server Error", e);
		process.exitCode = 1;
		if (shutdownAfterStart) {
			await shutdownAfterStart("SIGTERM");
		} else {
			await Promise.allSettled([app.close(), shutdownOpenTelemetry()]);
		}
	}
});
