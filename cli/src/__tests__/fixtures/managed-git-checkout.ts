import fs from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";
import type { CommandRunner } from "../../commands/install.js";

export const createGitCheckoutRunCommand = (sha: string, { bundleServerAssets = false } = {}) =>
  vi.fn(async (file: string, args: string[], _options?: Parameters<CommandRunner>[2]) => {
    if (file === "curl" && !args.includes("--output")) return { stdout: JSON.stringify({ sha }), stderr: "" };
    if (file === "curl") { fs.writeFileSync(args[args.indexOf("--output") + 1], "archive"); return { stdout: "", stderr: "" }; }
    if (file === "tar") {
      const checkout = args[args.indexOf("-C") + 1];
      const packages = [
        { dir: "packages/shared", name: "@groktopus/shared", packageJson: { name: "@groktopus/shared", version: bundleServerAssets ? "1.0.0" : "0.3.1" } },
        { dir: "packages/db", name: "@groktopus/db", packageJson: { name: "@groktopus/db", version: "0.3.1", dependencies: { "@groktopus/shared": "workspace:*" }, bundleDependencies: ["embedded-postgres"] } },
        { dir: "server", name: "@groktopus/server", packageJson: {
          name: "@groktopus/server", version: "0.3.1", dependencies: { "@groktopus/db": "workspace:*", ...(bundleServerAssets ? { "@groktopus/shared": "workspace:^" } : {}) },
          ...(bundleServerAssets ? { files: ["dist", "ui-dist", "skills"], bundleDependencies: ["a-server-dependency"] } : {}),
        } },
      ];
      fs.mkdirSync(path.join(checkout, "cli"), { recursive: true });
      fs.writeFileSync(path.join(checkout, "cli", "package.json"), JSON.stringify({ version: "0.3.1" }));
      if (bundleServerAssets) {
        fs.mkdirSync(path.join(checkout, "skills", "proprio"), { recursive: true });
        fs.writeFileSync(path.join(checkout, "skills", "proprio", "SKILL.md"), "# Proprio skill");
      }
      fs.mkdirSync(path.join(checkout, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(checkout, "scripts", "release-package-manifest.json"), JSON.stringify(packages.map(({ dir, name }) => ({ dir, name }))));
      for (const workspacePackage of packages) {
        fs.mkdirSync(path.join(checkout, workspacePackage.dir), { recursive: true });
        fs.writeFileSync(path.join(checkout, workspacePackage.dir, "package.json"), JSON.stringify(workspacePackage.packageJson));
      }
      return { stdout: "", stderr: "" };
    }
    if (path.basename(file) === "corepack") {
      if (args.includes("prepare:ui-dist")) {
        const checkout = _options?.cwd;
        if (typeof checkout !== "string") throw new Error("A Git checkout directory is required");
        const uiDist = path.join(checkout, "server", "ui-dist");
        fs.mkdirSync(uiDist, { recursive: true });
        fs.writeFileSync(path.join(uiDist, "index.html"), "<!doctype html>");
      }
      if (args.includes("pack")) {
        const destination = args[args.indexOf("--pack-destination") + 1];
        const packageDir = args[args.indexOf("--dir") + 1];
        const packageName = packageDir === "server" ? "proprio-server" : "proprio-shared";
        const version = bundleServerAssets && packageDir === "packages/shared" ? "1.0.0" : "0.3.1";
        fs.writeFileSync(path.join(destination, `${packageName}-${version}.tgz`), "package");
      }
      return { stdout: "", stderr: "" };
    }
    if (file === "bash") return { stdout: "", stderr: "" };
    if (file === "npm" && args[0] === "pack") {
      const stagedPackage = args[1]?.includes("workspace-package-") ? args[1] : null;
      if (bundleServerAssets && stagedPackage && !args.includes("--ignore-scripts")) {
        throw new Error("A staged bundle must not rerun workspace prepack hooks");
      }
      const manifest = stagedPackage
        ? JSON.parse(fs.readFileSync(path.join(stagedPackage, "package.json"), "utf8"))
        : { name: "proprio" };
      if (bundleServerAssets && manifest.name === "@groktopus/server") {
        expect(manifest.dependencies).toEqual({
          "@groktopus/db": "0.3.1",
          "@groktopus/shared": "^1.0.0",
          "a-server-dependency": "2.0.0",
        });
      }
      const packageName = manifest.name.replace("@groktopus/", "proprio-");
      fs.writeFileSync(path.join(args[args.indexOf("--pack-destination") + 1], `${packageName}-0.3.1.tgz`), "package");
      return { stdout: "", stderr: "" };
    }
    if (file === "sh" && args[4] === "install") {
      if (bundleServerAssets) expect([file, ...args.slice(0, 5)]).toEqual(
        ["sh", "-c", 'umask g-w,o-w && exec "$@"', "proprio-npm-install", "npm", "install"],
      );
      const prefix = args[args.indexOf("--prefix") + 1];
      const packageRoot = path.join(prefix, "node_modules", "proprio");
      fs.mkdirSync(path.join(packageRoot, "dist"), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version: "0.3.1" }));
      fs.writeFileSync(path.join(packageRoot, "dist", "index.js"), "#!/usr/bin/env node\n");
      return { stdout: "", stderr: "" };
    }
    if (file === process.execPath && args[0]?.endsWith("prepare-bundled-package.mjs")) {
      const isServer = path.basename(args[1]) === "server";
      if (isServer && !fs.existsSync(path.join(args[1], "ui-dist", "index.html"))) {
        throw new Error("Server UI missing at packaging");
      }
      if (isServer && !fs.existsSync(path.join(args[1], "skills", "proprio", "SKILL.md"))) {
        throw new Error("Server skills missing at packaging");
      }
      fs.mkdirSync(args[2], { recursive: true });
      fs.writeFileSync(path.join(args[2], "package.json"), JSON.stringify({
        name: isServer ? "@groktopus/server" : "@groktopus/db", version: "0.3.1",
        dependencies: isServer
          ? { "@groktopus/db": "0.3.1", "@groktopus/shared": "^0.3.1", "a-server-dependency": "2.0.0" }
          : { "@groktopus/shared": "0.3.1" },
      }));
      return { stdout: "", stderr: "" };
    }
    if (file === process.execPath) return { stdout: "0.3.1\n", stderr: "" };
    throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
  });
