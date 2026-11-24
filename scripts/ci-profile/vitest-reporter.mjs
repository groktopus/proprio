import { recorder, relativeFile } from "./record.mjs";
import { experimental_getRunnerTask } from "vitest/node";

export default class CiProfileReporter {
  record = recorder("vitest");
  trackBlockedTests = Boolean(process.env.PROPRIO_WORKSPACE_REGRESSION_DIR);
  selected = new Set();
  onTestRunStart() {
    this.selected.clear();
    this.record({ kind: "start" });
  }
  onTestRunEnd() { this.record({ kind: "end" }); }
  onTestModuleCollected(module) {
    if (!this.trackBlockedTests) return;
    for (const test of module.children.allTests("pending")) this.selected.add(test.id);
  }
  onTestCaseResult(test) {
    const timing = test.diagnostic();
    if (!timing?.startTime) return;
    this.record({
      kind: "test", id: test.id, parent: test.module.id,
      name: test.fullName, file: relativeFile(test.module.moduleId),
      start: timing.startTime, duration: timing.duration,
      status: test.result().state, retries: timing.retryCount,
    });
  }
  onTestModuleEnd(module) {
    if (this.trackBlockedTests) {
      const failedSuites = [module, ...module.children.allSuites()].filter(suite => suite.errors().length > 0);
      if (failedSuites.length > 0) {
        const blocked = new Set();
        for (const suite of failedSuites) {
          for (const test of suite.children.allTests("skipped")) {
            if (this.selected.has(test.id) && !test.diagnostic()?.startTime) blocked.add(test.id);
          }
        }
        this.record({ kind: "suite-error", file: relativeFile(module.moduleId), blockedTests: blocked.size });
      }
    }
    const timing = module.diagnostic();
    // ModuleDiagnostic has no startTime in Vitest 5. Use the worker's
    // timestamp, not the time the controller receives this reporter event.
    const start = experimental_getRunnerTask(module).result?.startTime;
    if (!start) return;
    this.record({
      kind: "file", id: module.id, name: relativeFile(module.moduleId),
      file: relativeFile(module.moduleId), start,
      duration: timing.duration, status: module.state(),
      collectMs: timing.collectDuration, setupMs: timing.setupDuration,
    });
  }
}
