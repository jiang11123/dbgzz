#!/usr/bin/env node

import { readdirSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";

const root = resolve(process.argv[2] || "web/dist");
// Bundled FFmpeg, MediaPipe and presets put the current full-feature build near
// 99.24 MiB. Keep a small growth allowance while retaining the release gate.
const budgetMiB = Number(process.env.BEEFTV_WEB_BUDGET_MIB || 105);
const files = [];

function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) files.push({ path: relative(root, path), bytes: statSync(path).size });
    }
}

walk(root);
files.sort((left, right) => right.bytes - left.bytes);
const total = files.reduce((sum, file) => sum + file.bytes, 0);
const totalMiB = total / 1024 / 1024;
const top = files.slice(0, 12).map((file) => `${(file.bytes / 1024 / 1024).toFixed(2)} MiB  ${file.path}`);

console.log(`BeefTV web release: ${totalMiB.toFixed(2)} MiB / ${budgetMiB.toFixed(2)} MiB budget`);
console.log(top.join("\n"));
if (totalMiB > budgetMiB) {
    console.error(`Release size exceeds budget by ${(totalMiB - budgetMiB).toFixed(2)} MiB`);
    process.exit(1);
}
