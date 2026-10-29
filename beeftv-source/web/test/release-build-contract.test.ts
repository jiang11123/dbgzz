import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

describe("desktop release build contract", () => {
    test("prepares generated plugin packages before the backend CI suite", () => {
        const workflow = readFileSync(resolve(root, ".github/workflows/quality.yml"), "utf8");
        const packageBuild = workflow.indexOf("sh ../plugin-packages/build-packages.sh");
        const goTest = workflow.indexOf("go test ./...");

        expect(packageBuild).toBeGreaterThan(-1);
        expect(goTest).toBeGreaterThan(packageBuild);
        expect(workflow).toContain("cache-dependency-path: backend/go.sum");
        expect(workflow).not.toContain("Payment plugin artifacts");
        expect(workflow).not.toContain("verify-payment-packages.sh");
    });

    test("keeps public container builds independent from removed payment artifacts", () => {
        const dockerfile = readFileSync(resolve(root, "backend/Dockerfile"), "utf8");
        const packageJson = JSON.parse(readFileSync(resolve(root, "web/package.json"), "utf8")) as {
            scripts?: Record<string, string>;
        };

        expect(dockerfile).toContain("AS protocol-package-build");
        expect(dockerfile).not.toContain("payment-package");
        expect(dockerfile).not.toContain("verify-payment-packages.sh");
        expect(dockerfile).not.toContain("migrate-schema");
        expect(dockerfile).not.toContain("migrate-sqlite-postgres");
        expect(packageJson.scripts?.test).toContain("scripts/run-test-suite.mjs");
        const testRunner = readFileSync(resolve(root, "web/scripts/run-test-suite.mjs"), "utf8");
        expect(testRunner).toContain('source.includes("globalThis")');
        expect(testRunner).toContain("for (const file of isolated) run([file])");
    });

    test("keeps published deployment aligned with binaries present in public source", () => {
        const workflow = readFileSync(resolve(root, ".github/workflows/publish-images.yml"), "utf8");
        expect(workflow).not.toContain("cmd/host-updater");
        expect(workflow).not.toContain("beeftv-host-updater");
        expect(workflow).not.toContain("docker-compose.deploy.yml");

        for (const name of ["docker-compose.server.yml", "docker-compose.deploy.yml"]) {
            expect(existsSync(resolve(root, name))).toBe(false);
        }

        for (const name of ["docker-compose.yml", "docker-compose.local.yml", "docker-compose.dev.yml"]) {
            const compose = readFileSync(resolve(root, name), "utf8");
            expect(compose).toContain("CANVAS_DATABASE_DRIVER");
            expect(compose).not.toMatch(/postgres|REDIS_URL/i);
        }
    });

    test("locks the release version and injects Go build metadata", () => {
        const script = readFileSync(resolve(root, "scripts/build-beeftv-release.sh"), "utf8");
        const version = readFileSync(resolve(root, "VERSION"), "utf8").trim();

        expect(version).toMatch(/^v\d+\.\d+\.\d+/);
        expect(script).toContain('VERSION_VALUE="$(tr -d');
        expect(script).toContain('CANVAS_BUILD_VERSION="$VERSION_VALUE"');
        expect(script).toContain("buildinfo.Version=$VERSION_VALUE");
        expect(script).toContain("buildinfo.Commit=$COMMIT_VALUE");
        expect(script).toContain("buildinfo.BuildTime=$BUILD_TIME_VALUE");
        expect(script).toContain("plutil -replace CFBundleShortVersionString");
        expect(script).toContain("plutil -replace CFBundleVersion");
        expect(script).toContain("-clean");
        expect(script).toContain("-trimpath");
        expect(script).toContain("wails@v2.16.0 build");
        expect(script).toContain("Contents/Resources/plugin-packages");
        expect(script).toContain('"$ROOT_DIR/plugin-packages/"*.beeftv-plugin');
    });

    test("keeps every source file required by the local release gate", () => {
        const gate = readFileSync(resolve(root, "scripts/verify-beeftv-local-release.sh"), "utf8");
        const exporter = readFileSync(resolve(root, "scripts/public-release-export.sh"), "utf8");

        expect(gate).toContain("web/scripts/beeftv-local-network-audit.mjs");
        expect(existsSync(resolve(root, "web/scripts/beeftv-local-network-audit.mjs"))).toBe(true);
        expect(exporter).toContain("--include='web/scripts/beeftv-local-network-audit.mjs'");
    });
});
