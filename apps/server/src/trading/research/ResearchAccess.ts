/** Server-side retained-result entitlement. The environment comes from the connection. */
export function canReadResearchResult(
  saved: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly datasetIds?: ReadonlyArray<string>;
  },
  connectionEnvironmentId: string,
  threadId: string,
  datasetId?: string,
): boolean {
  return (
    saved.environmentId === connectionEnvironmentId &&
    saved.threadId === threadId &&
    (datasetId === undefined || saved.datasetIds?.includes(datasetId) === true)
  );
}
