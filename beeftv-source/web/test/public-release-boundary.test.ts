import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const exportScript = join(repoRoot, "scripts/public-release-export.sh");
const auditScript = join(repoRoot, "scripts/public-release-audit.sh");
const workspaces: string[] = [];

function temporaryDirectory(prefix: string) {
    const directory = mkdtempSync(join(tmpdir(), prefix));
    workspaces.push(directory);
    return directory;
}

function fixtureFile(root: string, relativePath: string, contents = "fixture") {
    const target = join(root, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
}

afterEach(() => {
    while (workspaces.length > 0) {
        rmSync(workspaces.pop()!, { recursive: true, force: true });
    }
});

describe("public release boundary", () => {
    test("exports source while excluding private state and generated artifacts", () => {
        const source = temporaryDirectory("beeftv-public-source-");
        const destinationParent = temporaryDirectory("beeftv-public-destination-");
        const destination = join(destinationParent, "snapshot");

        fixtureFile(source, "README.md", "# BeefTV\n");
        fixtureFile(source, "LICENSE", "MIT\n");
        fixtureFile(source, "NOTICE", "Third-party notices\n");
        fixtureFile(source, "backend/go.mod", "module example.invalid/beeftv/backend\n");
        fixtureFile(source, "web/package.json", '{"name":"beeftv"}\n');
        fixtureFile(source, "web/src/main.tsx", "export {};\n");
        fixtureFile(source, "web/scripts/beeftv-local-network-audit.mjs", "export {};\n");
        fixtureFile(source, "web/scripts/private-audit.mjs", "export {};\n");
        fixtureFile(source, ".git/config");
        fixtureFile(source, ".worktrees/private/HEAD");
        fixtureFile(source, ".playwright-mcp/profile/Cookies");
        fixtureFile(source, "web/.playwright/profile/Cookies");
        fixtureFile(source, "artifacts/report.json");
        fixtureFile(source, "test-evidence/result.png");
        fixtureFile(source, "data/open_ai_canvas.db");
        fixtureFile(source, "backend/data/open_ai_canvas.sqlite3");
        fixtureFile(source, "backend/server");
        fixtureFile(source, "backend/desktop");
        fixtureFile(source, "backend/cmd/desktop/frontend/dist/.gitkeep", "");
        fixtureFile(source, "backend/cmd/desktop/frontend/dist/index.html", "generated");
        fixtureFile(source, "backend/cmd/desktop/build/bin/BeefTV.app/Contents/MacOS/BeefTV");
        fixtureFile(source, "debug.log");
        fixtureFile(source, "release.dmg");
        fixtureFile(source, "plugin-packages/example.beeftv-plugin");

        const result = spawnSync("sh", [exportScript, source, destination], { encoding: "utf8" });

        expect(result.status).toBe(0);
        expect(existsSync(join(destination, "web/src/main.tsx"))).toBe(true);
        expect(existsSync(join(destination, "web/scripts/beeftv-local-network-audit.mjs"))).toBe(true);
        expect(existsSync(join(destination, "web/scripts/private-audit.mjs"))).toBe(false);
        expect(existsSync(join(destination, ".git"))).toBe(false);
        expect(existsSync(join(destination, ".worktrees"))).toBe(false);
        expect(existsSync(join(destination, ".playwright-mcp"))).toBe(false);
        expect(existsSync(join(destination, "web/.playwright"))).toBe(false);
        expect(existsSync(join(destination, "artifacts"))).toBe(false);
        expect(existsSync(join(destination, "test-evidence"))).toBe(false);
        expect(existsSync(join(destination, "data"))).toBe(false);
        expect(existsSync(join(destination, "backend/data"))).toBe(false);
        expect(existsSync(join(destination, "backend/server"))).toBe(false);
        expect(existsSync(join(destination, "backend/desktop"))).toBe(false);
        expect(existsSync(join(destination, "backend/cmd/desktop/build"))).toBe(false);
        expect(existsSync(join(destination, "backend/cmd/desktop/frontend/dist/.gitkeep"))).toBe(true);
        expect(existsSync(join(destination, "backend/cmd/desktop/frontend/dist/index.html"))).toBe(false);
        expect(existsSync(join(destination, "debug.log"))).toBe(false);
        expect(existsSync(join(destination, "release.dmg"))).toBe(false);
        expect(existsSync(join(destination, "plugin-packages/example.beeftv-plugin"))).toBe(false);
    });

    test("audit rejects a forbidden artifact and accepts the clean export", () => {
        const source = temporaryDirectory("beeftv-public-audit-source-");
        const destinationParent = temporaryDirectory("beeftv-public-audit-destination-");
        const destination = join(destinationParent, "snapshot");

        fixtureFile(source, "README.md", "# BeefTV\n");
        fixtureFile(source, "LICENSE", "MIT\n");
        fixtureFile(source, "NOTICE", "Third-party notices\n");
        fixtureFile(source, "backend/go.mod", "module example.invalid/beeftv/backend\n");
        fixtureFile(source, "web/package.json", '{"name":"beeftv"}\n');

        expect(spawnSync("sh", [exportScript, source, destination]).status).toBe(0);
        fixtureFile(destination, ".git/config", `[core]\n\trepositoryformatversion = 0\n\tworktree = ${destination}\n`);
        expect(spawnSync("sh", [auditScript, destination]).status).toBe(0);

        fixtureFile(destination, "data/private.db");
        const rejected = spawnSync("sh", [auditScript, destination], { encoding: "utf8" });
        expect(rejected.error).toBeUndefined();
        expect(rejected.signal).toBeNull();
        expect(rejected.status).not.toBe(0);
        expect(`${rejected.stdout}${rejected.stderr}`).toContain("data/private.db");
    });

    test("export refuses to merge into an existing destination", () => {
        const source = temporaryDirectory("beeftv-public-existing-source-");
        const destination = temporaryDirectory("beeftv-public-existing-destination-");
        fixtureFile(source, "README.md", "# BeefTV\n");

        const result = spawnSync("sh", [exportScript, source, destination], { encoding: "utf8" });

        expect(result.error).toBeUndefined();
        expect(result.signal).toBeNull();
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain("destination already exists");
    });
});
