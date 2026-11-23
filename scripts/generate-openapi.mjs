import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildOpenApiDocument } from "../server/src/routes/openapi.ts";

const outputPath = fileURLToPath(new URL("../docs/api/openapi.json", import.meta.url));
const output = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current;
  try {
    current = await readFile(outputPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    current = undefined;
  }

  if (current !== output) {
    console.error("Generated API schema is stale. Run `pnpm docs:api:generate`.");
    process.exitCode = 1;
  } else {
    console.log("Generated API schema is up to date.");
  }
} else {
  await writeFile(outputPath, output);
  console.log(`Generated ${outputPath}`);
}
