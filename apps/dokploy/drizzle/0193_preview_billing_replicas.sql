ALTER TABLE "preview_deployments"
ADD COLUMN IF NOT EXISTS "billing_suspended_replicas" integer;