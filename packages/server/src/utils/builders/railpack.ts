import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { quote } from "shell-quote";
import {
	parseEnvironmentKeyValuePair,
	prepareEnvironmentVariables,
	prepareEnvironmentVariablesForShell,
} from "../docker/utils";
import { getBuildAppDirectory } from "../filesystem/directory";
import type { ApplicationNested } from ".";

const calculateSecretsHash = (envVariables: string[]): string => {
	const hash = createHash("sha256");
	for (const env of envVariables.sort()) {
		hash.update(env);
	}
	return hash.digest("hex");
};

export const getRailpackCommand = (
	application: ApplicationNested,
	options: { buildEnvironmentMode?: "inline" | "environment" } = {},
) => {
	const { env, appName, cleanCache } = application;
	const buildAppDirectory = getBuildAppDirectory(application);
	const rawEnvVariables = prepareEnvironmentVariables(
		env,
		application.environment.project.env,
		application.environment.env,
	);
	const envVariables = prepareEnvironmentVariablesForShell(
		env,
		application.environment.project.env,
		application.environment.env,
	);
	const environmentKeys = rawEnvVariables.map((entry) => {
		const [key] = parseEnvironmentKeyValuePair(entry);
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
			throw new Error(`Invalid build environment variable name: ${key}`);
		}
		return key;
	});

	// Prepare command
	const prepareArgs = [
		"prepare",
		buildAppDirectory,
		"--plan-out",
		`${buildAppDirectory}/railpack-plan.json`,
		"--info-out",
		`${buildAppDirectory}/railpack-info.json`,
	];

	for (const [index, environmentEntry] of envVariables.entries()) {
		if (options.buildEnvironmentMode === "environment") {
			const key = environmentKeys[index];
			if (!key) continue;
			prepareArgs.push("--env", `"${key}=\$${key}"`);
		} else {
			prepareArgs.push("--env", environmentEntry);
		}
	}

	// Calculate secrets hash for layer invalidation
	const secretsHash =
		options.buildEnvironmentMode === "environment"
			? "$secret_hash"
			: calculateSecretsHash(envVariables);

	const cacheKey = cleanCache ? nanoid(10) : undefined;
	// Build command.
	// Use a unique builder name per build so concurrent deployments don't race
	// on a shared "builder-containerd" instance (create/use/rm collisions).
	const builderName = `railpack-${appName}-${nanoid(6)}`;
	const buildArgs = [
		"buildx",
		"build",
		"--builder",
		builderName,
		"--build-arg",
		`secrets-hash=${secretsHash}`,
		...(cacheKey ? ["--build-arg", `cache-key=${cacheKey}`] : []),
		"--build-arg",
		`BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v${application.railpackVersion}`,
		"-f",
		`${buildAppDirectory}/railpack-plan.json`,
		"--output",
		`type=docker,name=${appName}`,
	];

	const exportEnvs = [];
	for (const pair of rawEnvVariables) {
		const [key, value] = parseEnvironmentKeyValuePair(pair);
		if (key && value) {
			buildArgs.push("--secret", `id=${key},env=${key}`);
			if (options.buildEnvironmentMode !== "environment") {
				exportEnvs.push(`export ${key}=${quote([value])}`);
			}
		}
	}

	buildArgs.push(buildAppDirectory);

	const bashCommand = `

# Ensure we have a builder with containerd (isolated per build)

export RAILPACK_VERSION=${application.railpackVersion}
if [ "\${VLYV_PREINSTALLED_RAILPACK:-false}" != "true" ]; then
	bash -c "$(curl -fsSL https://railpack.com/install.sh)"
fi
docker buildx create --name ${builderName} --driver docker-container || true

echo "Preparing Railpack build plan..." ;
railpack ${prepareArgs.join(" ")} || {
	echo "❌ Railpack prepare failed" ;
	docker buildx rm ${builderName} || true
	exit 1;
}
echo "✅ Railpack prepare completed." ;

echo "Building with Railpack frontend..." ;
# Export environment variables for secrets
${exportEnvs.join("\n")}
${
	options.buildEnvironmentMode === "environment"
		? `secret_hash=$(printf '%s\\0' ${environmentKeys.map((key) => `"$${key}"`).join(" ")} | sha256sum | cut -d ' ' -f 1)`
		: ""
}
docker ${buildArgs.join(" ")} || {
	echo "❌ Railpack build failed" ;
	docker buildx rm ${builderName} || true
	exit 1;
}
echo "✅ Railpack build completed." ;
docker buildx rm ${builderName} || true
`;

	return bashCommand;
};
