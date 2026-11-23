import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const ownerCheckout = process.env.PROPRIO_RELEASE_WORKFLOW_ROOT?.trim();

export function testExternalReleaseContract(name, callback) {
  return test(name, {
    skip: ownerCheckout ? false : "Set PROPRIO_RELEASE_WORKFLOW_ROOT to the owning workflow checkout",
  }, callback);
}

export function readExternalReleaseFile(path) {
  return readFileSync(resolve(ownerCheckout, path), "utf8");
}
