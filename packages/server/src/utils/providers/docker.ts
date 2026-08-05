import { safeDockerLoginCommand } from "@dokploy/server/services/registry";
import { quote } from "shell-quote";
import type { ApplicationNested } from "../builders";

export const getDockerSourceCredentialEnvironmentNames = () => ({
	url: "VLYV_SOURCE_REGISTRY_URL",
	username: "VLYV_SOURCE_REGISTRY_USERNAME",
	password: "VLYV_SOURCE_REGISTRY_PASSWORD",
});

export const buildRemoteDocker = async (
	application: ApplicationNested,
	credentialMode: "inline" | "environment" = "inline",
) => {
	const { registryUrl, dockerImage, username, password } = application;

	try {
		if (!dockerImage) {
			throw new Error("Docker image not found");
		}
		let command = `
echo ${quote([`Pulling ${dockerImage}`])};
		`;

		if (username && password) {
			const names = getDockerSourceCredentialEnvironmentNames();
			const loginCommand =
				credentialMode === "environment"
					? `if [ -n "$${names.url}" ]; then printf %s "$${names.password}" | docker login "$${names.url}" -u "$${names.username}" --password-stdin; else printf %s "$${names.password}" | docker login -u "$${names.username}" --password-stdin; fi`
					: safeDockerLoginCommand(registryUrl || "", username, password);
			command += `
if ! ${loginCommand} 2>&1; then
	echo "❌ Login failed";
	exit 1;
fi
`;
		}

		command += `
docker pull ${quote([dockerImage])} 2>&1 || {
  echo "❌ Pulling image failed";
  exit 1;
}

echo "✅ Pulling image completed.";
`;
		return command;
	} catch (error) {
		throw error;
	}
};
