import { relayStageSlug } from "./deploymentConfig.ts";

const PROD_DATABASE_NAME = "t3coderelay";

/**
 * Every stage shares one self-hosted Postgres server and gets its own
 * database on it. `prod` owns the canonical name; personal stages are
 * suffixed with the same DNS-safe slug Alchemy uses for physical names.
 */
export function relayDatabaseName(stage: string): string {
  return stage === "prod" ? PROD_DATABASE_NAME : `${PROD_DATABASE_NAME}_${relayStageSlug(stage)}`;
}
