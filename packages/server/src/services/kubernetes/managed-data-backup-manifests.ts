import type { ManagedDataKind } from "@dokploy/server/db/schema";
import type { KubernetesManifest } from "./manifests";

export type KubernetesManagedDataBackupSpec = {
	name: string;
	namespace: string;
	image: string;
	kind: ManagedDataKind;
	connectionUri: string;
	objectKey: string;
	storageProvider: "r2" | "s3";
	storageEndpoint: string;
	storageRegion: string;
	storageBucket: string;
	storageAccessKeyId: string;
	storageSecretAccessKey: string;
	serverSideEncryption?: "AES256" | "aws:kms";
	kmsKeyId?: string;
	operation?: "backup" | "restore";
	expectedChecksum?: string;
	nodeSelector?: Record<string, string>;
	tolerations?: Array<{
		key: string;
		value?: string;
		effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
	}>;
	activeDeadlineSeconds: number;
};

const immutableImage = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const resourceName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const objectKey = /^[a-zA-Z0-9._~!$&'()+,;=:@/-]{1,1024}$/;
const secretData = (values: Record<string, string>) =>
	Object.fromEntries(
		Object.entries(values).map(([key, value]) => [
			key,
			Buffer.from(value, "utf8").toString("base64"),
		]),
	);

const dumpCommand = (kind: ManagedDataKind) => {
	switch (kind) {
		case "postgres":
			return 'pg_dump --format=custom --compress=9 --file="$archive" "$VLYV_DATABASE_URI"';
		case "mysql":
		case "mariadb":
			return 'mysqlsh --uri "$VLYV_DATABASE_URI" -- util dump-instance /backup/mysql --compression=zstd --consistent=true >/tmp/mysqlsh.log 2>&1 && tar -C /backup -cf "$archive" mysql';
		case "mongo":
			return 'mongodump --uri="$VLYV_DATABASE_URI" --archive="$archive" --gzip';
		case "redis":
			return 'redis-dump -u "$VLYV_DATABASE_URI" >"$archive"';
		case "libsql":
			return 'turso db shell "$VLYV_DATABASE_URI" .dump | gzip -9 >"$archive"';
	}
};

const dumpTool = (kind: ManagedDataKind) => {
	switch (kind) {
		case "postgres":
			return "pg_dump";
		case "mysql":
		case "mariadb":
			return "mysqlsh";
		case "mongo":
			return "mongodump";
		case "redis":
			return "redis-dump";
		case "libsql":
			return "turso";
	}
};

const restoreCommand = (kind: ManagedDataKind) => {
	switch (kind) {
		case "postgres":
			return `psql "$VLYV_DATABASE_URI" -v ON_ERROR_STOP=1 -c "DO \\$\\$ DECLARE item record; BEGIN FOR item IN SELECT nspname FROM pg_namespace WHERE nspname <> 'information_schema' AND nspname NOT LIKE 'pg\\_%' LOOP EXECUTE format('DROP SCHEMA %I CASCADE', item.nspname); END LOOP; END \\$\\$;" && psql "$VLYV_DATABASE_URI" -v ON_ERROR_STOP=1 -c "CREATE SCHEMA public" && pg_restore --no-owner --no-privileges --dbname="$VLYV_DATABASE_URI" "$archive"`;
		case "mysql":
		case "mariadb":
			return 'echo "exact platform archive restore is unsupported for this engine" >&2; exit 1';
		case "mongo":
			return 'mongosh "$VLYV_DATABASE_URI" --quiet --eval "db.dropDatabase()" && mongorestore --uri="$VLYV_DATABASE_URI" --archive="$archive" --gzip';
		case "redis":
			return 'redis-cli -u "$VLYV_DATABASE_URI" FLUSHALL && redis-load -u "$VLYV_DATABASE_URI" <"$archive"';
		case "libsql":
			return 'echo "exact platform archive restore is unsupported for this engine" >&2; exit 1';
	}
};

const restoreTool = (kind: ManagedDataKind) => {
	switch (kind) {
		case "postgres":
			return "pg_restore psql";
		case "mysql":
		case "mariadb":
			return "mysqlsh";
		case "mongo":
			return "mongorestore mongosh";
		case "redis":
			return "redis-load redis-cli";
		case "libsql":
			return "turso";
	}
};

const restoreHealthCommand = (kind: ManagedDataKind) => {
	switch (kind) {
		case "postgres":
			return 'psql "$VLYV_DATABASE_URI" -v ON_ERROR_STOP=1 -Atc "select 1" | grep -qx 1';
		case "mysql":
		case "mariadb":
			return 'mysqlsh --uri "$VLYV_DATABASE_URI" --sql -e "select 1" >/tmp/restore-health.log 2>&1';
		case "mongo":
			return 'test "$(mongosh "$VLYV_DATABASE_URI" --quiet --eval "db.runCommand({ping:1}).ok")" = "1"';
		case "redis":
			return 'redis-cli -u "$VLYV_DATABASE_URI" PING | grep -qx PONG';
		case "libsql":
			return 'turso db shell "$VLYV_DATABASE_URI" "select 1" >/tmp/restore-health.log 2>&1';
	}
};

const databaseProtocols: Record<ManagedDataKind, string[]> = {
	postgres: ["postgres:", "postgresql:"],
	mysql: ["mysql:"],
	mariadb: ["mysql:", "mariadb:"],
	mongo: ["mongodb:", "mongodb+srv:"],
	redis: ["redis:", "rediss:"],
	libsql: ["libsql:", "https:"],
};

export const buildKubernetesManagedDataBackupManifests = (
	spec: KubernetesManagedDataBackupSpec,
): KubernetesManifest[] => {
	if (!immutableImage.test(spec.image)) {
		throw new Error("Managed data backup image must use an immutable digest");
	}
	if (!resourceName.test(spec.name) || !resourceName.test(spec.namespace)) {
		throw new Error("Managed data backup Kubernetes identity is invalid");
	}
	if (
		!objectKey.test(spec.objectKey) ||
		spec.objectKey.startsWith("/") ||
		spec.objectKey.split("/").some((part) => part === "." || part === "..")
	) {
		throw new Error("Managed data backup object key is invalid");
	}
	const connection = new URL(spec.connectionUri);
	if (!databaseProtocols[spec.kind].includes(connection.protocol)) {
		throw new Error("Managed data backup database protocol is invalid");
	}
	if (new URL(spec.storageEndpoint).protocol !== "https:") {
		throw new Error("Managed data backup storage must use HTTPS");
	}
	if (spec.serverSideEncryption !== "aws:kms" || !spec.kmsKeyId) {
		throw new Error("Managed data backup requires KMS encryption and a key ID");
	}
	const operation = spec.operation ?? "backup";
	if (
		operation === "restore" &&
		(!spec.expectedChecksum ||
			!/^sha256:[a-f0-9]{64}$/.test(spec.expectedChecksum))
	) {
		throw new Error("Managed data restore requires a trusted checksum");
	}
	const databasePort = connection.port
		? Number.parseInt(connection.port, 10)
		: spec.kind === "postgres"
			? 5432
			: spec.kind === "mysql" || spec.kind === "mariadb"
				? 3306
				: spec.kind === "mongo"
					? 27017
					: spec.kind === "redis"
						? 6379
						: 443;
	if (
		!Number.isInteger(databasePort) ||
		databasePort < 1 ||
		databasePort > 65_535
	) {
		throw new Error("Managed data backup database port is invalid");
	}
	const labels = {
		"app.kubernetes.io/name": spec.name,
		"app.kubernetes.io/managed-by": "vlyv",
		"app.kubernetes.io/component": `managed-data-${operation}`,
	};
	const secretName = `${spec.name}-credentials`;
	const backupScript = `
set -eu
archive=/backup/data.dump
for tool in rclone sha256sum stat jq tar gzip ${dumpTool(spec.kind)}; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing trusted backup tool: $tool"; exit 1; }
done
${dumpCommand(spec.kind)}
test -s "$archive" || { echo "database archive is empty"; exit 1; }
checksum="sha256:$(sha256sum "$archive" | cut -d ' ' -f 1)"
size=$(stat -c '%s' "$archive")
rclone copyto "$archive" "vlyv:$VLYV_STORAGE_BUCKET/$VLYV_OBJECT_KEY" --immutable --metadata-set "vlyv-sha256=$checksum" --checkers 4 --transfers 4
jq -cn --arg objectKey "$VLYV_OBJECT_KEY" --arg checksum "$checksum" --argjson sizeBytes "$size" '{objectKey:$objectKey,checksum:$checksum,sizeBytes:$sizeBytes}' >/dev/termination-log
`;
	const restoreScript = `
set -eu
archive=/backup/data.dump
for tool in rclone sha256sum stat jq tar gzip ${restoreTool(spec.kind)}; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing trusted restore tool: $tool"; exit 1; }
done
rclone copyto "vlyv:$VLYV_STORAGE_BUCKET/$VLYV_OBJECT_KEY" "$archive" --immutable --checkers 4 --transfers 4
test -s "$archive" || { echo "database archive is empty"; exit 1; }
checksum="sha256:$(sha256sum "$archive" | cut -d ' ' -f 1)"
test "$checksum" = "$VLYV_EXPECTED_CHECKSUM" || { echo "database archive checksum mismatch"; exit 1; }
${restoreCommand(spec.kind)}
${restoreHealthCommand(spec.kind)}
size=$(stat -c '%s' "$archive")
jq -cn --arg objectKey "$VLYV_OBJECT_KEY" --arg checksum "$checksum" --argjson sizeBytes "$size" '{objectKey:$objectKey,checksum:$checksum,sizeBytes:$sizeBytes}' >/dev/termination-log
`;
	const script = operation === "backup" ? backupScript : restoreScript;
	return [
		{
			apiVersion: "v1",
			kind: "Namespace",
			metadata: {
				name: spec.namespace,
				labels: {
					"app.kubernetes.io/managed-by": "vlyv",
					"pod-security.kubernetes.io/enforce": "restricted",
					"pod-security.kubernetes.io/audit": "restricted",
					"pod-security.kubernetes.io/warn": "restricted",
				},
			},
		},
		{
			apiVersion: "v1",
			kind: "ServiceAccount",
			metadata: {
				name: spec.name,
				namespace: spec.namespace,
				labels,
				annotations: { "vlyv.dev/garbage-collect-with-job": "true" },
			},
			automountServiceAccountToken: false,
		},
		{
			apiVersion: "v1",
			kind: "Secret",
			metadata: {
				name: secretName,
				namespace: spec.namespace,
				labels,
				annotations: { "vlyv.dev/garbage-collect-with-job": "true" },
			},
			type: "Opaque",
			data: secretData({
				VLYV_DATABASE_URI: spec.connectionUri,
				VLYV_STORAGE_BUCKET: spec.storageBucket,
				VLYV_OBJECT_KEY: spec.objectKey,
				...(operation === "restore"
					? { VLYV_EXPECTED_CHECKSUM: spec.expectedChecksum! }
					: {}),
				RCLONE_CONFIG_VLYV_TYPE: "s3",
				RCLONE_CONFIG_VLYV_PROVIDER:
					spec.storageProvider === "r2" ? "Cloudflare" : "Other",
				RCLONE_CONFIG_VLYV_ACCESS_KEY_ID: spec.storageAccessKeyId,
				RCLONE_CONFIG_VLYV_SECRET_ACCESS_KEY: spec.storageSecretAccessKey,
				RCLONE_CONFIG_VLYV_ENDPOINT: spec.storageEndpoint,
				RCLONE_CONFIG_VLYV_REGION: spec.storageRegion,
				RCLONE_CONFIG_VLYV_ACL: "private",
				RCLONE_CONFIG_VLYV_NO_CHECK_BUCKET: "true",
				RCLONE_CONFIG_VLYV_UPLOAD_CHECKSUM: "true",
				...(spec.serverSideEncryption
					? {
							RCLONE_CONFIG_VLYV_SERVER_SIDE_ENCRYPTION:
								spec.serverSideEncryption,
						}
					: {}),
				...(spec.kmsKeyId
					? { RCLONE_CONFIG_VLYV_SSE_KMS_KEY_ID: spec.kmsKeyId }
					: {}),
			}),
		},
		{
			apiVersion: "networking.k8s.io/v1",
			kind: "NetworkPolicy",
			metadata: {
				name: spec.name,
				namespace: spec.namespace,
				labels,
				annotations: { "vlyv.dev/garbage-collect-with-job": "true" },
			},
			spec: {
				podSelector: { matchLabels: labels },
				policyTypes: ["Ingress", "Egress"],
				ingress: [],
				egress: [
					{
						ports: [
							{ protocol: "UDP", port: 53 },
							{ protocol: "TCP", port: 53 },
						],
					},
					{
						to: [
							{
								ipBlock: {
									cidr: "0.0.0.0/0",
									except: [
										"0.0.0.0/8",
										"10.0.0.0/8",
										"127.0.0.0/8",
										"169.254.0.0/16",
										"172.16.0.0/12",
										"192.168.0.0/16",
									],
								},
							},
						],
						ports: [
							{ protocol: "TCP", port: 443 },
							...(databasePort === 443
								? []
								: [{ protocol: "TCP", port: databasePort }]),
						],
					},
				],
			},
		},
		{
			apiVersion: "batch/v1",
			kind: "Job",
			metadata: { name: spec.name, namespace: spec.namespace, labels },
			spec: {
				backoffLimit: 1,
				activeDeadlineSeconds: spec.activeDeadlineSeconds,
				ttlSecondsAfterFinished: 900,
				template: {
					metadata: { labels },
					spec: {
						serviceAccountName: spec.name,
						automountServiceAccountToken: false,
						restartPolicy: "Never",
						nodeSelector: spec.nodeSelector,
						tolerations: spec.tolerations,
						securityContext: {
							runAsNonRoot: true,
							seccompProfile: { type: "RuntimeDefault" },
						},
						containers: [
							{
								name: "backup",
								image: spec.image,
								command: ["/bin/sh", "-lc"],
								args: [script],
								envFrom: [{ secretRef: { name: secretName } }],
								resources: {
									requests: {
										cpu: "250m",
										memory: "256Mi",
										"ephemeral-storage": "1Gi",
									},
									limits: {
										cpu: "2",
										memory: "2Gi",
										"ephemeral-storage": "110Gi",
									},
								},
								securityContext: {
									allowPrivilegeEscalation: false,
									readOnlyRootFilesystem: true,
									capabilities: { drop: ["ALL"] },
								},
								terminationMessagePath: "/dev/termination-log",
								terminationMessagePolicy: "File",
								volumeMounts: [
									{ name: "backup", mountPath: "/backup" },
									{ name: "tmp", mountPath: "/tmp" },
								],
							},
						],
						volumes: [
							{ name: "backup", emptyDir: { sizeLimit: "110Gi" } },
							{ name: "tmp", emptyDir: { sizeLimit: "1Gi" } },
						],
					},
				},
			},
		},
	];
};
