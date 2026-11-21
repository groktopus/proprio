import { expect, it } from "vitest";
import { proprioCloudEnrollmentPrincipal } from "./proprio-cloud-connector-principal.js";

it("uses the same enrollment principal namespace for users and local board actors", () => {
  expect(proprioCloudEnrollmentPrincipal({ userId: "fixture-user", source: "session" })).toBe("user:fixture-user");
  expect(proprioCloudEnrollmentPrincipal({ source: "local_implicit" })).toBe("source:local_implicit");
  expect(proprioCloudEnrollmentPrincipal({ userId: "source:local_implicit" })).toBe("user:source:local_implicit");
  expect(proprioCloudEnrollmentPrincipal({})).toBe("source:board");
});
