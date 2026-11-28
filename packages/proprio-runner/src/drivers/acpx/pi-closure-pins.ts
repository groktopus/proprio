/**
 * Candidate closure pins from the isolated npm lock and official Node 24.21.0.
 * The non-Node graph is identical across targets, including platform resources.
 * Pi 1.0.0 dependency graphs were independently installed for all three targets.
 * Native platform execution and paid qualification remain separately required.
 * Changing any package, helper, extension or bootstrap requires regenerating all
 * three pins. Never accept a digest supplied only by an installed manifest.
 */
export const PI_DISTRIBUTION_CLOSURE_SHA256 = Object.freeze({
  "darwin-arm64": "13f45c97fce5d820b2640cb8f65216d832f1b5dc3c454c1cff1b302c91fa1fc9",
  "darwin-x64": "071037a43dccb39758d50fca91d92b37ff554f17323b694072fc6bdd7309e203",
  "linux-x64": "154a6fc9ead13cf08e89d9232d8735256ff323c3db5097b9157e35fef64af153",
});
