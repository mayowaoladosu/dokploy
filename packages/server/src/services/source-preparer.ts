import { getBuildCommand } from "@dokploy/server/utils/builders";
import type { RegistryCredentialMode } from "@dokploy/server/utils/cluster/upload";
import { cloneBitbucketRepository } from "@dokploy/server/utils/providers/bitbucket";
import { buildRemoteDocker } from "@dokploy/server/utils/providers/docker";
import { cloneGitRepository } from "@dokploy/server/utils/providers/git";
import { cloneGiteaRepository } from "@dokploy/server/utils/providers/gitea";
import { cloneGithubRepository } from "@dokploy/server/utils/providers/github";
import { cloneGitlabRepository } from "@dokploy/server/utils/providers/gitlab";
import { generateApplyPatchesCommand } from "./patch";
import type {
	ApplicationReleaseIntent,
	ReleaseApplication,
} from "./release-types";

export type PreparedSource = {
	command: string;
	sourceCommand: string;
	buildCommand: string;
	metadata: {
		sourceType: ReleaseApplication["sourceType"];
		buildType: ReleaseApplication["buildType"];
		cloned: boolean;
		patchesApplied: boolean;
	};
};

export interface SourcePreparer {
	prepare(input: {
		application: ReleaseApplication;
		intent: ApplicationReleaseIntent;
		workspace: "persistent" | "fresh";
	}): Promise<PreparedSource>;
}

type SourcePreparerOptions = {
	registryCredentialMode: RegistryCredentialMode;
	uploadApplicationRegistries: boolean;
	buildEnvironmentMode?: "inline" | "environment";
};

const clonesSource = (intent: ApplicationReleaseIntent) =>
	intent.kind === "deploy" || intent.kind === "preview-deploy";

/**
 * Owns source acquisition, patch application and Railpack/build planning. The
 * release caller provides semantic intent and never needs provider-specific
 * clone commands or registry credential modes.
 */
export const createApplicationSourcePreparer = ({
	registryCredentialMode,
	uploadApplicationRegistries,
	buildEnvironmentMode = "inline",
}: SourcePreparerOptions): SourcePreparer => ({
	prepare: async ({ application, intent, workspace }) => {
		const shouldClone = workspace === "fresh" || clonesSource(intent);
		const buildServerId = application.buildServerId || application.serverId;
		const buildApplication = {
			...application,
			serverId: buildServerId,
			credentialMode: registryCredentialMode,
		};
		let sourceCommand = "";

		if (shouldClone) {
			if (application.sourceType === "github") {
				sourceCommand += await cloneGithubRepository(buildApplication);
			} else if (application.sourceType === "gitlab") {
				sourceCommand += await cloneGitlabRepository(buildApplication);
			} else if (application.sourceType === "gitea") {
				sourceCommand += await cloneGiteaRepository(buildApplication);
			} else if (application.sourceType === "bitbucket") {
				sourceCommand += await cloneBitbucketRepository(buildApplication);
			} else if (application.sourceType === "git") {
				sourceCommand += await cloneGitRepository(buildApplication);
			} else if (application.sourceType === "docker") {
				sourceCommand += await buildRemoteDocker(
					application,
					registryCredentialMode,
				);
			}
		}

		const shouldApplyPatches =
			shouldClone && application.sourceType !== "docker";
		if (shouldApplyPatches) {
			sourceCommand += await generateApplyPatchesCommand({
				id: intent.sourceApplicationId || application.applicationId,
				type: "application",
				serverId: buildServerId,
				appName: application.appName,
			});
		}

		const buildCommand = await getBuildCommand(application, {
			registryCredentialMode,
			uploadApplicationRegistries,
			buildEnvironmentMode,
		});

		return {
			command: `${sourceCommand}${buildCommand}`,
			sourceCommand,
			buildCommand,
			metadata: {
				sourceType: application.sourceType,
				buildType: application.buildType,
				cloned: shouldClone,
				patchesApplied: shouldApplyPatches,
			},
		};
	},
});
