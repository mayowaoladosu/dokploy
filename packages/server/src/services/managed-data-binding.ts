import { db } from "@dokploy/server/db";
import { dbUrl } from "@dokploy/server/db/constants";
import {
	applications,
	environments,
	managedDataBindings,
	managedDataResources,
	platformClusters,
	platformPlacements,
	projects,
} from "@dokploy/server/db/schema";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { prepareEnvironmentVariables } from "../utils/docker/utils";
import { createKubernetesControlPlane } from "./kubernetes/client";
import {
	type KubernetesManifest,
	kubernetesApplicationResourceName,
} from "./kubernetes/manifests";
import { withManagedDataResourceMutationLock } from "./managed-data-provider";

const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;

const environmentMap = (entries: string[]): Record<string, string> =>
	Object.fromEntries(
		entries
			.filter((entry) => entry.includes("="))
			.map(
				(entry) =>
					[
						entry.slice(0, entry.indexOf("=")).trim(),
						entry.slice(entry.indexOf("=") + 1),
					] as const,
			)
			.filter(([name]) => ENVIRONMENT_NAME.test(name)),
	);

const tenantBinding = (binding: typeof managedDataBindings.$inferSelect) => ({
	managedDataBindingId: binding.managedDataBindingId,
	managedDataResourceId: binding.managedDataResourceId,
	applicationId: binding.applicationId,
	environmentVariable: binding.environmentVariable,
	createdAt: binding.createdAt,
	updatedAt: binding.updatedAt,
});

const withManagedDataApplicationLock = async <T>(
	applicationId: string,
	operation: () => Promise<T>,
) => {
	const lockClient = postgres(dbUrl, {
		max: 1,
		idle_timeout: 0,
		connect_timeout: 10,
	});
	const lockName = `vlyv:managed-data-application:${applicationId}`;
	const [lock] = await lockClient<{ acquired: boolean }[]>`
		select pg_try_advisory_lock(hashtextextended(${lockName}, 0)) as acquired
	`;
	if (!lock?.acquired) {
		await lockClient.end();
		throw new TRPCError({
			code: "CONFLICT",
			message: "Another managed data binding operation is running",
		});
	}
	try {
		return await operation();
	} finally {
		try {
			await lockClient`
				select pg_advisory_unlock(hashtextextended(${lockName}, 0))
			`;
		} finally {
			await lockClient.end();
		}
	}
};

const bindingScope = async (
	managedDataResourceId: string,
	applicationId: string,
	organizationId: string,
) => {
	const [row] = await db
		.select({
			resourceId: managedDataResources.managedDataResourceId,
			resourceEnvironmentId: managedDataResources.environmentId,
			applicationEnvironmentId: applications.environmentId,
		})
		.from(managedDataResources)
		.innerJoin(applications, eq(applications.applicationId, applicationId))
		.innerJoin(
			environments,
			eq(environments.environmentId, applications.environmentId),
		)
		.innerJoin(projects, eq(projects.projectId, environments.projectId))
		.where(
			and(
				eq(managedDataResources.managedDataResourceId, managedDataResourceId),
				eq(managedDataResources.organizationId, organizationId),
				eq(projects.organizationId, organizationId),
				eq(managedDataResources.status, "ready"),
			),
		)
		.limit(1);
	if (!row || row.resourceEnvironmentId !== row.applicationEnvironmentId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data resource or application was not found",
		});
	}
};

const createManagedDataBindingUnlocked = async (input: {
	managedDataResourceId: string;
	applicationId: string;
	organizationId: string;
	environmentVariable: string;
}) => {
	if (!ENVIRONMENT_NAME.test(input.environmentVariable)) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Managed data environment variable is invalid",
		});
	}
	await bindingScope(
		input.managedDataResourceId,
		input.applicationId,
		input.organizationId,
	);
	const existing = await db.query.managedDataBindings.findFirst({
		where: and(
			eq(managedDataBindings.applicationId, input.applicationId),
			eq(managedDataBindings.environmentVariable, input.environmentVariable),
		),
	});
	if (
		existing &&
		existing.managedDataResourceId !== input.managedDataResourceId
	) {
		throw new TRPCError({
			code: "CONFLICT",
			message:
				"Unbind the existing data service before rebinding this variable",
		});
	}
	const [binding] = await db
		.insert(managedDataBindings)
		.values(input)
		.onConflictDoUpdate({
			target: [
				managedDataBindings.applicationId,
				managedDataBindings.environmentVariable,
			],
			set: {
				managedDataResourceId: input.managedDataResourceId,
				appliedCredentialVersion: 0,
				updatedAt: new Date(),
			},
		})
		.returning();
	if (!binding) throw new Error("Failed to bind managed data resource");
	await synchronizeManagedDataBindingSecrets(input.managedDataResourceId);
	return tenantBinding(binding);
};

export const createManagedDataBinding = async (input: {
	managedDataResourceId: string;
	applicationId: string;
	organizationId: string;
	environmentVariable: string;
}) =>
	withManagedDataResourceMutationLock(input.managedDataResourceId, () =>
		withManagedDataApplicationLock(input.applicationId, () =>
			createManagedDataBindingUnlocked(input),
		),
	);

const removeManagedDataBindingUnlocked = async (
	managedDataBindingId: string,
	organizationId: string,
	expectedResourceId: string,
) => {
	const binding = await db.query.managedDataBindings.findFirst({
		where: eq(managedDataBindings.managedDataBindingId, managedDataBindingId),
		with: { resource: true },
	});
	if (
		!binding?.resource ||
		binding.resource.organizationId !== organizationId
	) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data binding was not found",
		});
	}
	if (binding.managedDataResourceId !== expectedResourceId) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Managed data binding changed concurrently",
		});
	}
	await synchronizeApplicationManagedDataSecrets(binding.applicationId, [
		binding.environmentVariable,
	]);
	await db
		.delete(managedDataBindings)
		.where(eq(managedDataBindings.managedDataBindingId, managedDataBindingId));
	return true;
};

export const removeManagedDataBinding = async (
	managedDataBindingId: string,
	organizationId: string,
) => {
	const binding = await db.query.managedDataBindings.findFirst({
		where: eq(managedDataBindings.managedDataBindingId, managedDataBindingId),
	});
	if (!binding) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data binding was not found",
		});
	}
	return withManagedDataResourceMutationLock(
		binding.managedDataResourceId,
		() =>
			withManagedDataApplicationLock(binding.applicationId, () =>
				removeManagedDataBindingUnlocked(
					managedDataBindingId,
					organizationId,
					binding.managedDataResourceId,
				),
			),
	);
};

export const managedDataEnvironmentForApplication = async (
	applicationId: string,
) => {
	const bindings = await db.query.managedDataBindings.findMany({
		where: eq(managedDataBindings.applicationId, applicationId),
		with: { resource: true },
	});
	return bindings.map((binding) => {
		if (
			!binding.resource ||
			binding.resource.status !== "ready" ||
			!binding.resource.connectionUri
		) {
			throw new Error(
				`Managed data binding ${binding.managedDataBindingId} is unavailable`,
			);
		}
		return `${binding.environmentVariable}=${binding.resource.connectionUri}`;
	});
};

const synchronizeApplicationManagedDataSecrets = async (
	applicationId: string,
	removeKeys: string[] = [],
) => {
	const [application, placement] = await Promise.all([
		db.query.applications.findFirst({
			where: eq(applications.applicationId, applicationId),
			with: { environment: { with: { project: true } } },
		}),
		db.query.platformPlacements.findFirst({
			where: eq(platformPlacements.applicationId, applicationId),
			with: { runtimeTarget: { with: { cluster: true } } },
		}),
	]);
	if (!application || !placement?.runtimeTarget?.cluster) return false;
	const cluster = placement.runtimeTarget.cluster;
	if (cluster.runtime !== "kubernetes" || cluster.status !== "active") {
		return false;
	}
	const client = createKubernetesControlPlane({
		kubeconfig: cluster.kubeconfig,
		inCluster: cluster.metadata.inCluster,
	});
	const name = kubernetesApplicationResourceName(applicationId);
	const secretName = `${name}-env`;
	const identity = {
		apiVersion: "v1",
		kind: "Secret",
		metadata: { name: secretName, namespace: placement.namespace },
	};
	const current = (await client.read(identity)) as
		| (typeof identity & { type?: string; data?: Record<string, string> })
		| null;
	if (!current) {
		throw new Error("Managed runtime environment Secret is unavailable");
	}
	const base = environmentMap(
		prepareEnvironmentVariables(
			application.env,
			application.environment.project.env,
			application.environment.env,
		),
	);
	const bindings = await db.query.managedDataBindings.findMany({
		where: eq(managedDataBindings.applicationId, applicationId),
		with: { resource: true },
	});
	const managed: Record<string, string> = {};
	for (const binding of bindings) {
		if (
			removeKeys.includes(binding.environmentVariable) ||
			!binding.resource ||
			(binding.resource.status !== "ready" &&
				binding.resource.status !== "restoring") ||
			!binding.resource.connectionUri
		) {
			continue;
		}
		managed[binding.environmentVariable] = binding.resource.connectionUri;
	}
	const data = { ...(current.data ?? {}) };
	for (const key of removeKeys) {
		if (base[key] === undefined && managed[key] === undefined) delete data[key];
	}
	for (const [key, value] of Object.entries({ ...base, ...managed })) {
		data[key] = Buffer.from(value, "utf8").toString("base64");
	}
	const secret: KubernetesManifest = {
		...identity,
		type: current.type || "Opaque",
		data,
	};
	await client.apply([secret]);
	await client.restartDeployment(placement.namespace, name);
	const deadline = Date.now() + 5 * 60_000;
	while (Date.now() < deadline) {
		const deployment = await client.readDeployment(placement.namespace, name);
		const desired = deployment?.spec?.replicas ?? 1;
		if (
			(deployment?.status?.readyReplicas ?? 0) >= desired &&
			(deployment?.status?.availableReplicas ?? 0) >= desired
		) {
			break;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
	}
	const deployment = await client.readDeployment(placement.namespace, name);
	const desired = deployment?.spec?.replicas ?? 1;
	if (
		(deployment?.status?.readyReplicas ?? 0) < desired ||
		(deployment?.status?.availableReplicas ?? 0) < desired
	) {
		throw new Error("Managed runtime did not recover after Secret rollout");
	}
	for (const binding of bindings) {
		if (!binding.resource) continue;
		await db
			.update(managedDataBindings)
			.set({
				appliedCredentialVersion: binding.resource.credentialVersion,
				updatedAt: new Date(),
			})
			.where(
				eq(
					managedDataBindings.managedDataBindingId,
					binding.managedDataBindingId,
				),
			);
	}
	return true;
};

export const synchronizeManagedDataBindingSecrets = async (
	managedDataResourceId?: string,
) => {
	const bindings = await db.query.managedDataBindings.findMany({
		...(managedDataResourceId
			? {
					where: eq(
						managedDataBindings.managedDataResourceId,
						managedDataResourceId,
					),
				}
			: {}),
		with: { resource: true },
	});
	const applications = new Set(
		bindings
			.filter(
				(binding) =>
					binding.resource &&
					(binding.resource.status === "ready" ||
						(managedDataResourceId !== undefined &&
							binding.resource.status === "restoring")) &&
					binding.appliedCredentialVersion < binding.resource.credentialVersion,
			)
			.map((binding) => binding.applicationId),
	);
	let synchronized = 0;
	for (const applicationId of applications) {
		const didSynchronize = await withManagedDataApplicationLock(
			applicationId,
			() => synchronizeApplicationManagedDataSecrets(applicationId),
		);
		if (!didSynchronize) {
			throw new Error(
				`Managed runtime placement is unavailable for application ${applicationId}`,
			);
		}
		synchronized += 1;
	}
	return synchronized;
};

export type QuiescedManagedDataBinding = {
	applicationId: string;
	clusterId: string;
	namespace: string;
	deploymentName: string;
	replicas: number;
	hpaSpec?: Record<string, unknown>;
};

type ManagedDataHpaState = {
	metadata?: { generation?: number };
	spec?: Record<string, unknown>;
	status?: {
		observedGeneration?: number;
		conditions?: Array<{ type?: string; status?: string }>;
	};
};

export const planManagedDataBindingQuiesce = async (
	managedDataResourceId: string,
) => {
	const bindings = await db.query.managedDataBindings.findMany({
		where: eq(managedDataBindings.managedDataResourceId, managedDataResourceId),
	});
	const plans: QuiescedManagedDataBinding[] = [];
	for (const applicationId of new Set(
		bindings.map((binding) => binding.applicationId),
	)) {
		const placement = await db.query.platformPlacements.findFirst({
			where: eq(platformPlacements.applicationId, applicationId),
			with: { runtimeTarget: { with: { cluster: true } } },
		});
		const cluster = placement?.runtimeTarget?.cluster;
		if (
			!placement ||
			!cluster ||
			cluster.runtime !== "kubernetes" ||
			cluster.status !== "active"
		) {
			throw new Error(
				"Every bound application must have an active Kubernetes placement before restore",
			);
		}
		const client = createKubernetesControlPlane({
			kubeconfig: cluster.kubeconfig,
			inCluster: cluster.metadata.inCluster,
		});
		const deploymentName = kubernetesApplicationResourceName(applicationId);
		const deployment = await client.readDeployment(
			placement.namespace,
			deploymentName,
		);
		if (!deployment) {
			throw new Error("Bound application Deployment is unavailable");
		}
		const hpa = (await client.read({
			apiVersion: "autoscaling/v2",
			kind: "HorizontalPodAutoscaler",
			metadata: { name: deploymentName, namespace: placement.namespace },
		})) as { spec?: Record<string, unknown> } | null;
		plans.push({
			applicationId,
			clusterId: cluster.clusterId,
			namespace: placement.namespace,
			deploymentName,
			replicas: deployment.spec?.replicas ?? 1,
			hpaSpec: hpa?.spec,
		});
	}
	return plans;
};

export const quiesceManagedDataBindings = async (
	managedDataResourceId: string,
	planned?: QuiescedManagedDataBinding[],
) => {
	const quiesced: QuiescedManagedDataBinding[] = [];
	try {
		for (const entry of planned ??
			(await planManagedDataBindingQuiesce(managedDataResourceId))) {
			const cluster = await db.query.platformClusters.findFirst({
				where: eq(platformClusters.clusterId, entry.clusterId),
			});
			if (!cluster)
				throw new Error("Managed data runtime cluster is unavailable");
			const client = createKubernetesControlPlane({
				kubeconfig: cluster.kubeconfig,
				inCluster: cluster.metadata.inCluster,
			});
			if (entry.hpaSpec) {
				await client.delete({
					apiVersion: "autoscaling/v2",
					kind: "HorizontalPodAutoscaler",
					metadata: { name: entry.deploymentName, namespace: entry.namespace },
				});
			}
			quiesced.push(entry);
			await client.setDeploymentReplicas(
				entry.namespace,
				entry.deploymentName,
				0,
			);
			const deadline = Date.now() + 2 * 60_000;
			while (Date.now() < deadline) {
				const current = await client.readDeployment(
					entry.namespace,
					entry.deploymentName,
				);
				if ((current?.status?.readyReplicas ?? 0) === 0) break;
				await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
			}
			const current = await client.readDeployment(
				entry.namespace,
				entry.deploymentName,
			);
			if ((current?.status?.readyReplicas ?? 0) !== 0) {
				throw new Error("Bound application did not quiesce before restore");
			}
			const selector = Object.entries(
				current?.spec?.selector?.matchLabels ?? {},
			)
				.map(([key, value]) => `${key}=${value}`)
				.join(",");
			if (!selector) {
				throw new Error("Bound application has no authoritative pod selector");
			}
			const pods = await client.listPods(entry.namespace, selector);
			if (
				pods.some(
					(pod) =>
						pod.status?.phase !== "Succeeded" && pod.status?.phase !== "Failed",
				)
			) {
				throw new Error(
					"Bound application pods are still running before restore",
				);
			}
		}
		return quiesced;
	} catch (error) {
		await resumeManagedDataBindings(quiesced);
		throw error;
	}
};

export async function resumeManagedDataBindings(
	bindings: QuiescedManagedDataBinding[],
) {
	const results = await Promise.allSettled(
		bindings.map(async (binding) => {
			const cluster = await db.query.platformClusters.findFirst({
				where: eq(platformClusters.clusterId, binding.clusterId),
			});
			if (!cluster)
				throw new Error("Managed data runtime cluster is unavailable");
			const client = createKubernetesControlPlane({
				kubeconfig: cluster.kubeconfig,
				inCluster: cluster.metadata.inCluster,
			});
			await client.setDeploymentReplicas(
				binding.namespace,
				binding.deploymentName,
				binding.replicas,
			);
			const deadline = Date.now() + 5 * 60_000;
			while (Date.now() < deadline) {
				const deployment = await client.readDeployment(
					binding.namespace,
					binding.deploymentName,
				);
				if (
					(deployment?.status?.readyReplicas ?? 0) >= binding.replicas &&
					(deployment?.status?.availableReplicas ?? 0) >= binding.replicas
				) {
					if (binding.hpaSpec) {
						await client.apply([
							{
								apiVersion: "autoscaling/v2",
								kind: "HorizontalPodAutoscaler",
								metadata: {
									name: binding.deploymentName,
									namespace: binding.namespace,
								},
								spec: binding.hpaSpec,
							} as KubernetesManifest,
						]);
						const hpaDeadline = Date.now() + 2 * 60_000;
						let restoredHpa: ManagedDataHpaState | null = null;
						while (Date.now() < hpaDeadline) {
							restoredHpa = (await client.read({
								apiVersion: "autoscaling/v2",
								kind: "HorizontalPodAutoscaler",
								metadata: {
									name: binding.deploymentName,
									namespace: binding.namespace,
								},
							})) as unknown as ManagedDataHpaState | null;
							const generation = restoredHpa?.metadata?.generation ?? 1;
							const observed = restoredHpa?.status?.observedGeneration ?? 0;
							const conditions = restoredHpa?.status?.conditions ?? [];
							const controllerReady = ["AbleToScale", "ScalingActive"].every(
								(type) =>
									conditions.some(
										(condition) =>
											condition.type === type && condition.status === "True",
									),
							);
							if (
								restoredHpa?.spec &&
								observed >= generation &&
								controllerReady
							)
								break;
							await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
						}
						if (
							!restoredHpa?.spec ||
							(restoredHpa.status?.observedGeneration ?? 0) <
								(restoredHpa.metadata?.generation ?? 1) ||
							!["AbleToScale", "ScalingActive"].every((type) =>
								restoredHpa.status?.conditions?.some(
									(condition) =>
										condition.type === type && condition.status === "True",
								),
							) ||
							restoredHpa.spec.minReplicas !== binding.hpaSpec.minReplicas ||
							restoredHpa.spec.maxReplicas !== binding.hpaSpec.maxReplicas
						) {
							throw new Error(
								"Bound application HPA did not recover after restore",
							);
						}
					}
					return;
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
			}
			throw new Error("Bound application did not recover after data restore");
		}),
	);
	const failure = results.find(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (failure) throw failure.reason;
}

export const listManagedDataBindings = async (
	managedDataResourceId: string,
	organizationId: string,
) => {
	const resource = await db.query.managedDataResources.findFirst({
		where: and(
			eq(managedDataResources.managedDataResourceId, managedDataResourceId),
			eq(managedDataResources.organizationId, organizationId),
		),
	});
	if (!resource) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Managed data resource not found",
		});
	}
	return db.query.managedDataBindings
		.findMany({
			where: eq(
				managedDataBindings.managedDataResourceId,
				managedDataResourceId,
			),
		})
		.then((bindings) => bindings.map(tenantBinding));
};
