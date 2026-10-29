#!/usr/bin/env node
/**
 * Compare two 8-bit RGBA screenshots without adding an image dependency.
 * Usage: node scripts/compare-canvas-screenshots.mjs original.png pyrite.png
 */
import fs from "node:fs";
import zlib from "node:zlib";

function decodePng(file) {
    const bytes = fs.readFileSync(file);
    if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error(`${file} is not a PNG`);
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idat = [];
    while (offset < bytes.length) {
        const size = bytes.readUInt32BE(offset);
        const type = bytes.toString("ascii", offset + 4, offset + 8);
        const data = bytes.subarray(offset + 8, offset + 8 + size);
        if (type === "IHDR") {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data[8];
            colorType = data[9];
        } else if (type === "IDAT") idat.push(data);
        else if (type === "IEND") break;
        offset += size + 12;
    }
    if (!width || !height || bitDepth !== 8 || ![2, 6].includes(colorType)) throw new Error(`${file} must be an 8-bit RGB/RGBA PNG`);
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const sourceStride = width * (colorType === 6 ? 4 : 3);
    const sourceBytesPerPixel = colorType === 6 ? 4 : 3;
    const stride = width * 4;
    const pixels = Buffer.alloc(height * stride);
    const reconstructedRows = Buffer.alloc(height * sourceStride);
    let source = 0;
    for (let y = 0; y < height; y += 1) {
        const filter = raw[source++];
        const row = raw.subarray(source, source + sourceStride);
        source += sourceStride;
        const previous = y ? reconstructedRows.subarray((y - 1) * sourceStride, y * sourceStride) : null;
        const target = reconstructedRows.subarray(y * sourceStride, (y + 1) * sourceStride);
        for (let x = 0; x < sourceStride; x += 1) {
            const left = x >= sourceBytesPerPixel ? row[x - sourceBytesPerPixel] : 0;
            const up = previous ? previous[x] : 0;
            const upperLeft = previous && x >= sourceBytesPerPixel ? previous[x - sourceBytesPerPixel] : 0;
            const value = row[x];
            if (filter === 0) target[x] = value;
            else if (filter === 1) target[x] = (value + left) & 255;
            else if (filter === 2) target[x] = (value + up) & 255;
            else if (filter === 3) target[x] = (value + Math.floor((left + up) / 2)) & 255;
            else if (filter === 4) {
                const estimate = left + up - upperLeft;
                const pa = Math.abs(estimate - left);
                const pb = Math.abs(estimate - up);
                const pc = Math.abs(estimate - upperLeft);
                target[x] = (value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upperLeft)) & 255;
            } else throw new Error(`Unsupported PNG filter ${filter}`);
        }
        // Expand the reconstructed source row into RGBA. Keep the output
        // buffer separate so the next row's Up predictor sees source bytes.
        for (let x = 0; x < width; x += 1) {
            const sourceOffset = x * sourceBytesPerPixel;
            const targetOffset = x * 4;
            const rgbaRow = pixels.subarray(y * stride, (y + 1) * stride);
            rgbaRow[targetOffset] = target[sourceOffset];
            rgbaRow[targetOffset + 1] = target[sourceOffset + 1];
            rgbaRow[targetOffset + 2] = target[sourceOffset + 2];
            rgbaRow[targetOffset + 3] = colorType === 6 ? target[sourceOffset + 3] : 255;
        }
    }
    return { width, height, pixels };
}

const [originalPath, pyritePath] = process.argv.slice(2);
if (!originalPath || !pyritePath) {
    console.error("Usage: node scripts/compare-canvas-screenshots.mjs original.png pyrite.png");
    process.exit(2);
}
const original = decodePng(originalPath);
const pyrite = decodePng(pyritePath);
if (original.width !== pyrite.width || original.height !== pyrite.height) throw new Error(`Viewport mismatch: ${original.width}x${original.height} vs ${pyrite.width}x${pyrite.height}`);

let total = 0;
let changedPixels = 0;
let maxDelta = 0;
let minX = original.width;
let minY = original.height;
let maxX = -1;
let maxY = -1;
for (let y = 0; y < original.height; y += 1) {
    for (let x = 0; x < original.width; x += 1) {
        const offset = (y * original.width + x) * 4;
        let delta = 0;
        for (let channel = 0; channel < 4; channel += 1) delta += Math.abs(original.pixels[offset + channel] - pyrite.pixels[offset + channel]);
        total += delta;
        const average = delta / 4;
        maxDelta = Math.max(maxDelta, average);
        if (average > 8) {
            changedPixels += 1;
            minX = Math.min(minX, x); minY = Math.min(minY, y);
            maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        }
    }
}
const pixelCount = original.width * original.height;
const meanAbsoluteChannelDelta = total / (pixelCount * 4);
console.log(JSON.stringify({
    viewport: `${original.width}x${original.height}`,
    meanAbsoluteChannelDelta: Number(meanAbsoluteChannelDelta.toFixed(3)),
    normalizedSimilarity: Number((1 - meanAbsoluteChannelDelta / 255).toFixed(4)),
    changedPixelRatio: Number((changedPixels / pixelCount).toFixed(4)),
    maxAveragePixelDelta: Number(maxDelta.toFixed(1)),
    changedBounds: changedPixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
}, null, 2));
