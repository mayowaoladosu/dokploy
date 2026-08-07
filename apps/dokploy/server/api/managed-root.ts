import { aiRouter } from "./routers/ai";
import { applicationRouter } from "./routers/application";
import { bitbucketRouter } from "./routers/bitbucket";
import { deploymentRouter } from "./routers/deployment";
import { domainRouter } from "./routers/domain";
import { environmentRouter } from "./routers/environment";
import { gitProviderRouter } from "./routers/git-provider";
import { giteaRouter } from "./routers/gitea";
import { githubRouter } from "./routers/github";
import { gitlabRouter } from "./routers/gitlab";
import { managedDataRouter } from "./routers/managed-data";
import { managedSettingsRouter } from "./routers/managed-settings";
import { mountRouter } from "./routers/mount";
import { notificationRouter } from "./routers/notification";
import { observabilityRouter } from "./routers/observability";
import { organizationRouter } from "./routers/organization";
import { patchRouter } from "./routers/patch";
import { portRouter } from "./routers/port";
import { previewDeploymentRouter } from "./routers/preview-deployment";
import { projectRouter } from "./routers/project";
import { auditLogRouter } from "./routers/proprietary/audit-log";
import { customRoleRouter } from "./routers/proprietary/custom-role";
import { forwardAuthRouter } from "./routers/proprietary/forward-auth";
import { scimRouter } from "./routers/proprietary/scim";
import { ssoRouter } from "./routers/proprietary/sso";
import { whitelabelingRouter } from "./routers/proprietary/whitelabeling";
import { redirectsRouter } from "./routers/redirects";
import { rollbackRouter } from "./routers/rollbacks";
import { securityRouter } from "./routers/security";
import { polarRouter } from "./routers/polar";
import { tagRouter } from "./routers/tag";
import { usageRouter } from "./routers/usage";
import { userRouter } from "./routers/user";
import { createTRPCRouter } from "./trpc";

/**
 * Managed tenant API: product resources only. Host, Docker, Swarm, cluster,
 * registry, certificate, destination, legacy database, compose, and platform
 * operator routers are intentionally absent from this router.
 */
export const managedTenantRouter = createTRPCRouter({
	ai: aiRouter,
	application: applicationRouter,
	auditLog: auditLogRouter,
	bitbucket: bitbucketRouter,
	customRole: customRoleRouter,
	deployment: deploymentRouter,
	domain: domainRouter,
	environment: environmentRouter,
	forwardAuth: forwardAuthRouter,
	gitProvider: gitProviderRouter,
	gitea: giteaRouter,
	github: githubRouter,
	gitlab: gitlabRouter,
	managedData: managedDataRouter,
	mounts: mountRouter,
	notification: notificationRouter,
	observability: observabilityRouter,
	organization: organizationRouter,
	patch: patchRouter,
	port: portRouter,
	previewDeployment: previewDeploymentRouter,
	project: projectRouter,
	redirects: redirectsRouter,
	rollback: rollbackRouter,
	scim: scimRouter,
	security: securityRouter,
	settings: managedSettingsRouter,
	sso: ssoRouter,
	polar: polarRouter,
	tag: tagRouter,
	usage: usageRouter,
	user: userRouter,
	whitelabeling: whitelabelingRouter,
});

export type ManagedTenantRouter = typeof managedTenantRouter;
