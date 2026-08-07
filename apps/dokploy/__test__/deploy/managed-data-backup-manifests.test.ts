import { buildKubernetesManagedDataBackupManifests } from "@dokploy/server/services/kubernetes/managed-data-backup-manifests";
import { describe, expect, it } from "vitest";

const findManifest = (manifests: Array<Record<string, any>>, kind: string) => {
	const manifest = manifests.find((entry) => entry.kind === kind);
	if (!manifest) throw new Error(`${kind} manifest was not generated`);
	return manifest;
};

describe("managed data platform archive manifests", () => {
	const manifests = buildKubernetesManagedDataBackupManifests({
		name: "data-backup-abc123",
		namespace: "vlyv-data-backups",
		image: `registry.vlyv.dev/data-backup@sha256:${"a".repeat(64)}`,
		kind: "postgres",
		connectionUri:
			"postgres://app:database-secret@db.example.com/app?sslmode=require",
		objectKey: "managed-data/tenant/resource/backup/data.dump",
		storageProvider: "s3",
		storageEndpoint: "https://s3.us-east-1.amazonaws.com",
		storageRegion: "us-east-1",
		storageBucket: "vlyv-backups",
		storageAccessKeyId: "access-key",
		storageSecretAccessKey: "storage-secret",
		serverSideEncryption: "aws:kms",
		kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/abc",
		registryCredentials: {
			server: "registry.vlyv.dev",
			username: "backup-puller",
			password: "registry-secret",
		},
		activeDeadlineSeconds: 3600,
	});

	it("runs a digest-pinned, restricted, credential-isolated backup job", () => {
		const job = findManifest(manifests, "Job");
		const container = job.spec.template.spec.containers[0];
		const secret = findManifest(manifests, "Secret");

		expect(container.image).toContain("@sha256:");
		expect(container.securityContext).toMatchObject({
			allowPrivilegeEscalation: false,
			readOnlyRootFilesystem: true,
			capabilities: { drop: ["ALL"] },
		});
		expect(container.args[0]).toContain("pg_dump --format=custom");
		expect(container.args[0]).toContain("sha256sum");
		expect(container.args[0]).toContain("rclone copyto");
		expect(secret.data).toHaveProperty("VLYV_DATABASE_URI");
		expect(secret.data).toHaveProperty(
			"RCLONE_CONFIG_VLYV_SERVER_SIDE_ENCRYPTION",
		);
		expect(secret.type).toBe("kubernetes.io/dockerconfigjson");
		expect(secret.data).toHaveProperty(".dockerconfigjson");
		expect(job.spec.template.spec.imagePullSecrets).toEqual([
			{ name: secret.metadata.name },
		]);
		expect(JSON.stringify(job)).not.toContain("database-secret");
		expect(JSON.stringify(job)).not.toContain("storage-secret");
		expect(JSON.stringify(job)).not.toContain("registry-secret");
	});

	it("default-denies ingress and private network egress", () => {
		const policy = findManifest(manifests, "NetworkPolicy");
		expect(policy.spec.ingress).toEqual([]);
		const publicRule = policy.spec.egress.find((rule: any) => rule.to);
		expect(publicRule.to[0].ipBlock.cidr).toBe("0.0.0.0/0");
		expect(publicRule.to[0].ipBlock.except).toContain("169.254.0.0/16");
		expect(publicRule.to[0].ipBlock.except).toContain("10.0.0.0/8");
	});

	it("restores only checksum-verified archives and health-checks the database", () => {
		const restore = buildKubernetesManagedDataBackupManifests({
			name: "data-restore-abc123",
			namespace: "vlyv-data-backups",
			image: `registry.vlyv.dev/data-backup@sha256:${"a".repeat(64)}`,
			kind: "postgres",
			connectionUri:
				"postgres://app:database-secret@db.example.com/app?sslmode=require",
			objectKey: "managed-data/tenant/resource/backup/data.dump",
			storageProvider: "s3",
			storageEndpoint: "https://s3.us-east-1.amazonaws.com",
			storageRegion: "us-east-1",
			storageBucket: "vlyv-backups",
			storageAccessKeyId: "access-key",
			storageSecretAccessKey: "storage-secret",
			serverSideEncryption: "aws:kms",
			kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/abc",
			operation: "restore",
			expectedChecksum: `sha256:${"b".repeat(64)}`,
			activeDeadlineSeconds: 3600,
		});
		const job = findManifest(restore, "Job");
		const script = job.spec.template.spec.containers[0].args[0];
		expect(script).toContain("rclone copyto");
		expect(script).toContain("database archive checksum mismatch");
		expect(script).toContain("DROP SCHEMA %I CASCADE");
		expect(script).toContain("pg_restore --no-owner --no-privileges");
		expect(script).toContain("select 1");
		expect(JSON.stringify(job)).not.toContain("database-secret");
	});

	it("rejects mutable images, engine mismatches, and missing KMS keys", () => {
		expect(() =>
			buildKubernetesManagedDataBackupManifests({
				...({} as any),
				image: "registry.vlyv.dev/data-backup:latest",
			}),
		).toThrow("immutable digest");
		expect(() =>
			buildKubernetesManagedDataBackupManifests({
				...({
					name: "backup",
					namespace: "backups",
					image: `backup@sha256:${"a".repeat(64)}`,
					kind: "postgres",
					connectionUri: "redis://secret@redis.example.com:6379",
					objectKey: "backup/data.dump",
					storageEndpoint: "https://s3.example.com",
					serverSideEncryption: "AES256",
				} as any),
			}),
		).toThrow("database protocol");
		expect(() =>
			buildKubernetesManagedDataBackupManifests({
				...({
					name: "backup",
					namespace: "backups",
					image: `backup@sha256:${"a".repeat(64)}`,
					kind: "postgres",
					connectionUri: "postgres://db.example.com/app",
					objectKey: "backup/data.dump",
					storageEndpoint: "https://s3.example.com",
					serverSideEncryption: "aws:kms",
				} as any),
			}),
		).toThrow("requires KMS encryption and a key ID");
		expect(() =>
			buildKubernetesManagedDataBackupManifests({
				...({
					name: "restore",
					namespace: "backups",
					image: `backup@sha256:${"a".repeat(64)}`,
					kind: "postgres",
					connectionUri: "postgres://db.example.com/app",
					objectKey: "backup/data.dump",
					storageProvider: "s3",
					storageEndpoint: "https://s3.example.com",
					storageRegion: "us-east-1",
					storageBucket: "backups",
					storageAccessKeyId: "key",
					storageSecretAccessKey: "secret",
					serverSideEncryption: "aws:kms",
					kmsKeyId: "kms-key",
					operation: "restore",
					activeDeadlineSeconds: 3600,
				} as any),
			}),
		).toThrow("requires a trusted checksum");
	});
});
