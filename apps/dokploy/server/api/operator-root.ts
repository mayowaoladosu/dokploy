import { adminRouter } from "./routers/admin";
import { backupRouter } from "./routers/backup";
import { certificateRouter } from "./routers/certificate";
import { clusterRouter } from "./routers/cluster";
import { destinationRouter } from "./routers/destination";
import { dockerRouter } from "./routers/docker";
import { networkRouter } from "./routers/network";
import { platformEdgeRouter } from "./routers/platform-edge";
import { platformInfrastructureRouter } from "./routers/platform-infrastructure";
import { platformManagedDataRouter } from "./routers/platform-managed-data";
import { registryRouter } from "./routers/registry";
import { serverRouter } from "./routers/server";
import { settingsRouter } from "./routers/settings";
import { sshRouter } from "./routers/ssh-key";
import { swarmRouter } from "./routers/swarm";
import { volumeBackupsRouter } from "./routers/volume-backups";
import { createTRPCRouter } from "./trpc";

/** Separate API surface for globally authorized platform operators. */
export const operatorRouter = createTRPCRouter({
	admin: adminRouter,
	backup: backupRouter,
	certificates: certificateRouter,
	cluster: clusterRouter,
	destination: destinationRouter,
	docker: dockerRouter,
	managedData: platformManagedDataRouter,
	network: networkRouter,
	platformEdge: platformEdgeRouter,
	platformInfrastructure: platformInfrastructureRouter,
	registry: registryRouter,
	server: serverRouter,
	settings: settingsRouter,
	sshKey: sshRouter,
	swarm: swarmRouter,
	volumeBackups: volumeBackupsRouter,
});

export type OperatorRouter = typeof operatorRouter;
