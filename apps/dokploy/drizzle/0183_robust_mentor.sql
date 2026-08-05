UPDATE "domain" SET "host" = lower(trim(trailing '.' from btrim("host")));--> statement-breakpoint
CREATE UNIQUE INDEX "domain_host_unique" ON "domain" USING btree (lower("host"));