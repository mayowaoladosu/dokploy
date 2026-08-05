import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { mechanizeDockerContainer } from "@dokploy/server/utils/builders";
import { removeService } from "@dokploy/server/utils/docker/utils";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import type { BuildExecutionArtifact } from "./build-executor";
import type { ReleaseApplication } from "./release-types";

export type RuntimeApplication = ReleaseApplication & {
	domains?: Array<{
		host: string;
		https: boolean;
		path: string | null;
	}>;
};

export type RuntimeStatus = {
	provider: string;
	imageRef: string | null;
	desiredReplicas: number;
	readyReplicas: number;
	state: "missing" | "pending" | "ready" | "failed";
	message?: string;
};

export type RuntimeHealthResult = {
	passed: boolean;
	endpoint?: string;
	latencyMs: number;
	statusCode?: number;
	error?: string;
	checkedAt: string;
};

export interface RuntimeScheduler {
	readonly provider: string;
	getCurrentImage(application: RuntimeApplication): Promise<string | null>;
	schedule(input: {
		application: RuntimeApplication;
		artifact: Pick<BuildExecutionArtifact, "imageRef">;
		timeoutMs?: number;
	}): Promise<RuntimeStatus>;
	verifyHealth(input: {
		application: RuntimeApplication;
		timeoutMs?: number;
	}): Promise<RuntimeHealthResult>;
	rollback(input: {
		application: RuntimeApplication;
		imageRef: string;
		timeoutMs?: number;
	}): Promise<RuntimeStatus>;
	remove(input: { application: RuntimeApplication }): Promise<void>;
}

type SchedulerOptions = {
	pollIntervalMs?: number;
	sleep?: (durationMs: number) => Promise<void>;
	fetcher?: typeof fetch;
};

const isPrivateIpv4 = (address: string) => {
	const octets = address.split(".").map(Number);
	const [first, second, third] = octets;
	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 169 && second === 254) ||
		(first === 172 && second !== undefined && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		(first === 192 && second === 0 && (third === 0 || third === 2)) ||
		(first === 198 && second !== undefined && second >= 18 && second <= 19) ||
		(first === 198 && second === 51 && third === 100) ||
		(first === 203 && second === 0 && third === 113) ||
		(first === 100 && second !== undefined && second >= 64 && second <= 127) ||
		(first !== undefined && first >= 224)
	);
};

const isPrivateIp = (address: string) => {
	if (isIP(address) === 4) return isPrivateIpv4(address);
	if (isIP(address) !== 6) return true;
	const normalized = address.toLowerCase();
	return (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		normalized.startsWith("fe8") ||
		normalized.startsWith("fe9") ||
		normalized.startsWith("fea") ||
		normalized.startsWith("feb")
	);
};

export const assertPublicHealthEndpoint = async (
	endpoint: string,
	lookup: typeof dns.lookup = dns.lookup,
) => {
	const url = new URL(endpoint);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Health endpoint must use HTTP or HTTPS");
	}
	const addresses = await lookup(url.hostname, { all: true, verbatim: true });
	if (
		addresses.length === 0 ||
		addresses.some(({ address }) => isPrivateIp(address))
	) {
		throw new Error("Health endpoint must resolve only to public IP addresses");
	}
};

export const verifyHttpEndpoint = async ({
	endpoint,
	timeoutMs,
	pollIntervalMs,
	fetcher,
	sleep,
	validateEndpoint = assertPublicHealthEndpoint,
	now = Date.now,
}: {
	endpoint: string;
	timeoutMs: number;
	pollIntervalMs: number;
	fetcher: typeof fetch;
	sleep: (durationMs: number) => Promise<void>;
	validateEndpoint?: (endpoint: string) => Promise<void>;
	now?: () => number;
}): Promise<RuntimeHealthResult> => {
	await validateEndpoint(endpoint);
	const startedAt = now();
	const deadline = startedAt + timeoutMs;
	let lastError = "Health endpoint did not respond";
	let statusCode: number | undefined;
	while (now() < deadline) {
		const requestStartedAt = now();
		try {
			const response = await fetcher(endpoint, {
				redirect: "manual",
				signal: AbortSignal.timeout(Math.min(10_000, timeoutMs)),
			});
			statusCode = response.status;
			if (response.status >= 200 && response.status < 500) {
				return {
					passed: true,
					endpoint,
					latencyMs: now() - requestStartedAt,
					statusCode: response.status,
					checkedAt: new Date().toISOString(),
				};
			}
			lastError = `Health endpoint returned HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await sleep(pollIntervalMs);
	}

	return {
		passed: false,
		endpoint,
		latencyMs: now() - startedAt,
		statusCode,
		error: lastError,
		checkedAt: new Date().toISOString(),
	};
};

const defaultSleep = (durationMs: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, durationMs));

const getDesiredReplicas = (application: RuntimeApplication) =>
	Math.max(application.replicas ?? 1, 1);

const imageReferencesMatch = (
	candidate: string | undefined,
	expected: string,
) => {
	if (candidate === expected) return true;
	const candidateDigest = candidate?.split("@")[1];
	const expectedDigest = expected.split("@")[1];
	return Boolean(candidateDigest && candidateDigest === expectedDigest);
};

export const summarizeSwarmTasks = (
	tasks: Array<{
		DesiredState?: string;
		Spec?: { ContainerSpec?: { Image?: string } };
		Status?: { State?: string; Err?: string; Message?: string };
	}>,
	desiredReplicas: number,
	expectedImageRef?: string,
): Pick<RuntimeStatus, "readyReplicas" | "state" | "message"> => {
	const relevantTasks = expectedImageRef
		? tasks.filter((task) =>
				imageReferencesMatch(task.Spec?.ContainerSpec?.Image, expectedImageRef),
			)
		: tasks;
	const readyReplicas = relevantTasks.filter(
		(task) =>
			task.DesiredState === "running" && task.Status?.State === "running",
	).length;
	if (readyReplicas >= desiredReplicas) {
		return { readyReplicas, state: "ready" };
	}

	const failure = relevantTasks.find(
		(task) =>
			task.Status?.State === "failed" || task.Status?.State === "rejected",
	);
	if (failure) {
		return {
			readyReplicas,
			state: "failed",
			message:
				failure.Status?.Err ||
				failure.Status?.Message ||
				`Swarm task entered ${failure.Status?.State}`,
		};
	}
	return { readyReplicas, state: "pending" };
};

export const createSwarmRuntimeScheduler = (
	options: SchedulerOptions = {},
): RuntimeScheduler => {
	const pollIntervalMs = options.pollIntervalMs ?? 2_000;
	const sleep = options.sleep ?? defaultSleep;
	const fetcher = options.fetcher ?? fetch;

	const getStatus = async (
		application: RuntimeApplication,
	): Promise<RuntimeStatus> => {
		const docker = await getRemoteDocker(application.serverId);
		const desiredReplicas = getDesiredReplicas(application);
		try {
			const service = await docker.getService(application.appName).inspect();
			const imageRef =
				service.Spec?.TaskTemplate?.ContainerSpec?.Image?.toString() ?? null;
			const tasks = await docker.listTasks({
				filters: JSON.stringify({ service: [application.appName] }),
			});
			const summary = summarizeSwarmTasks(
				tasks,
				desiredReplicas,
				imageRef ?? undefined,
			);
			return {
				provider: "swarm",
				imageRef,
				desiredReplicas,
				...summary,
			};
		} catch (error) {
			const statusCode = (error as { statusCode?: number }).statusCode;
			if (statusCode === 404) {
				return {
					provider: "swarm",
					imageRef: null,
					desiredReplicas,
					readyReplicas: 0,
					state: "missing",
				};
			}
			throw error;
		}
	};

	const waitUntilReady = async (
		application: RuntimeApplication,
		timeoutMs: number,
	) => {
		const deadline = Date.now() + timeoutMs;
		let latest: RuntimeStatus | null = null;
		while (Date.now() < deadline) {
			latest = await getStatus(application);
			if (latest.state === "ready") return latest;
			if (latest.state === "failed") {
				throw new Error(latest.message || "Runtime task failed");
			}
			await sleep(pollIntervalMs);
		}
		throw new Error(
			`Runtime did not become ready within ${timeoutMs}ms${latest?.message ? `: ${latest.message}` : ""}`,
		);
	};

	const scheduleImage = async (
		application: RuntimeApplication,
		imageRef: string,
		timeoutMs: number,
	) => {
		await mechanizeDockerContainer(application, imageRef);
		return waitUntilReady(application, timeoutMs);
	};

	return {
		provider: "swarm",
		getCurrentImage: async (application) =>
			(await getStatus(application)).imageRef,
		schedule: async ({ application, artifact, timeoutMs = 120_000 }) =>
			scheduleImage(application, artifact.imageRef, timeoutMs),
		verifyHealth: async ({ application, timeoutMs = 120_000 }) => {
			const startedAt = Date.now();
			const domain = (application.releaseDomains ?? application.domains)?.find(
				(entry) => Boolean(entry.host),
			);
			const shouldCheckHttp =
				Boolean(domain) && process.env.PLATFORM_HTTP_HEALTH_CHECK === "true";
			if (!shouldCheckHttp || !domain) {
				const runtime = await waitUntilReady(application, timeoutMs);
				return {
					passed: runtime.state === "ready",
					latencyMs: Date.now() - startedAt,
					checkedAt: new Date().toISOString(),
				};
			}

			const endpoint = `${domain.https ? "https" : "http"}://${domain.host}${domain.path || "/"}`;
			return verifyHttpEndpoint({
				endpoint,
				timeoutMs,
				pollIntervalMs,
				fetcher,
				sleep,
			});
		},
		rollback: async ({ application, imageRef, timeoutMs = 120_000 }) =>
			scheduleImage(application, imageRef, timeoutMs),
		remove: async ({ application }) => {
			await removeService(application.appName, application.serverId);
		},
	};
};
