import { IS_MANAGED_PAAS } from "@dokploy/server/constants";
import { getImageName } from "@dokploy/server/utils/builders";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { getRemoteDocker } from "@dokploy/server/utils/servers/remote-docker";
import { quote } from "shell-quote";
import type { ReleaseApplication } from "./release-types";

export type BuildExecutionArtifact = {
	imageId: string;
	imageDigest: string | null;
	imageRef: string;
	imageSizeBytes: number | null;
	builder: string;
	executor: string;
	durationMs: number;
	metadata: Record<string, unknown>;
};

export type BuildExecutionInput = {
	application: ReleaseApplication;
	deploymentId: string;
	sourceCommand: string;
	buildCommand: string;
	logPath: string;
	buildServerId: string | null;
};

export interface BuildExecutor {
	readonly name: string;
	readonly isolation: "host" | "ephemeral";
	execute(input: BuildExecutionInput): Promise<BuildExecutionArtifact>;
	cancel(input: {
		deploymentId: string;
		buildServerId: string | null;
		application: ReleaseApplication;
	}): Promise<void>;
}

const repositoryFromImageRef = (imageRef: string) =>
	imageRef.split("@")[0]?.replace(/:[^/:]+$/, "") ?? imageRef;

export const selectImmutableImageRef = ({
	runtimeImageRef,
	imageId,
	repoDigests,
}: {
	runtimeImageRef: string;
	imageId: string;
	repoDigests: string[];
}) => {
	const expectedRepository = repositoryFromImageRef(runtimeImageRef);
	const digest = repoDigests.find(
		(candidate) => repositoryFromImageRef(candidate) === expectedRepository,
	);
	return {
		imageRef: digest || imageId || runtimeImageRef,
		imageDigest: digest?.split("@")[1] ?? (imageId || null),
		isRegistryDigest: Boolean(digest),
	};
};

const captureArtifact = async (
	input: BuildExecutionInput,
	durationMs: number,
	executor: string,
): Promise<BuildExecutionArtifact> => {
	const docker = await getRemoteDocker(input.buildServerId);
	const runtimeImageRef = await getImageName(input.application);
	const localImageRef =
		input.application.sourceType === "docker"
			? runtimeImageRef
			: `${input.application.appName}:latest`;
	const image = await docker.getImage(localImageRef).inspect();
	const immutable = selectImmutableImageRef({
		runtimeImageRef,
		imageId: image.Id ?? "",
		repoDigests: image.RepoDigests ?? [],
	});

	if (
		IS_MANAGED_PAAS &&
		input.application.buildServerId &&
		input.application.buildServerId !== input.application.serverId &&
		!immutable.isRegistryDigest
	) {
		throw new Error(
			"A registry digest is required when managed build and runtime nodes differ",
		);
	}

	return {
		imageId: image.Id ?? "",
		imageDigest: immutable.imageDigest,
		imageRef: immutable.imageRef,
		imageSizeBytes: image.Size ?? null,
		builder: input.application.buildType,
		executor,
		durationMs,
		metadata: {
			runtimeImageRef,
			isRegistryDigest: immutable.isRegistryDigest,
			buildServerId: input.buildServerId,
		},
	};
};

/**
 * Compatibility adapter for the existing SSH/local build path. Managed
 * Kubernetes installs replace this adapter with an ephemeral job executor.
 */
export const createShellBuildExecutor = (): BuildExecutor => ({
	name: "shell",
	isolation: "host",
	execute: async (input) => {
		const startedAt = Date.now();
		const command = `(set -e;${input.sourceCommand}${input.buildCommand}) >> ${quote([input.logPath])} 2>&1`;
		if (input.buildServerId) {
			await execAsyncRemote(input.buildServerId, command);
		} else {
			await execAsync(command);
		}
		return captureArtifact(input, Date.now() - startedAt, "shell");
	},
	cancel: async ({ buildServerId }) => {
		const command =
			"pkill -INT -f 'railpack|docker buildx build|docker build' 2>/dev/null || true";
		if (buildServerId) {
			await execAsyncRemote(buildServerId, command);
		} else {
			await execAsync(command);
		}
	},
});
