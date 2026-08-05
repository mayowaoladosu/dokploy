import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { quote } from "shell-quote";
import { encodeBase64 } from "../utils/docker/utils";

/**
 * Appends a sanitized failure summary without allowing log persistence errors
 * to replace the deployment's original failure.
 */
export const appendDeploymentFailureLog = async ({
	error,
	logPath,
	serverId,
}: {
	error: unknown;
	logPath: string;
	serverId: string | null;
}) => {
	let command = "";
	if (!(error instanceof ExecError)) {
		const message = error instanceof Error ? error.message : String(error);
		command += `printf %s ${quote([encodeBase64(message)])} | base64 -d >> ${quote([logPath])};`;
	}
	command += `printf '\\nError occurred ❌, check the logs for details.\\n' >> ${quote([logPath])};`;
	try {
		if (serverId) await execAsyncRemote(serverId, command);
		else await execAsync(command);
	} catch (logError) {
		console.error("Failed to append deployment failure log", logError);
	}
};
