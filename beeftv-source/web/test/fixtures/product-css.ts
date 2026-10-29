import { build } from "vite";

export async function productCss() {
    const result = await build({ configFile: false, root: import.meta.dir + "/../..", logLevel: "error", build: { write: false, rollupOptions: { input: import.meta.dir + "/../../src/styles/globals.css" } } });
    if (Array.isArray(result) || !("output" in result)) throw new Error("Expected one CSS build");
    return result.output.filter(output => output.type === "asset" && output.fileName.endsWith(".css")).map(output => output.source).join("\n") + await Bun.file(import.meta.dir + "/../../src/styles/workspace-product.css").text();
}
