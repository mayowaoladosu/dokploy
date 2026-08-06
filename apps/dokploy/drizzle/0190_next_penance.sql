WITH ranked_previews AS (
	SELECT
		"previewDeploymentId",
		row_number() OVER (
			PARTITION BY "applicationId", "pullRequestId"
			ORDER BY ("domainId" IS NOT NULL) DESC, "createdAt" DESC, "previewDeploymentId" DESC
		) AS duplicate_rank
	FROM "preview_deployments"
)
DELETE FROM "preview_deployments" AS preview
USING ranked_previews AS ranked
WHERE preview."previewDeploymentId" = ranked."previewDeploymentId"
	AND ranked.duplicate_rank > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "previewDeployment_applicationPullRequest_unique" ON "preview_deployments" USING btree ("applicationId","pullRequestId");