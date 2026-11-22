/** A successful Vitest command is insufficient when platform fixtures can skip. */
export function assertRequiredVitestTests(result, required) {
  for (const [path, titles] of Object.entries(required)) {
    const files = result.testResults.filter(entry => entry.name.replaceAll('\\', '/').endsWith(`/${path}`));
    if (files.length !== 1) throw new Error(`Required test file was not reported exactly once: ${path}`);
    for (const title of titles) {
      const matches = files[0].assertionResults.filter(test => test.title === title);
      if (matches.length !== 1 || matches[0].status !== 'passed') {
        throw new Error(`Required test did not pass exactly once: ${path}: ${title}`);
      }
    }
  }
}
