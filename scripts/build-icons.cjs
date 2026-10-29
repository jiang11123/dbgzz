// Convert the approved avatar into app assets. Run with Electron in Node mode.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(() => {
const root = path.resolve(__dirname, '..');
const source = nativeImage.createFromPath(path.join(root, 'build/brand-avatar.png'));
if (source.isEmpty()) throw new Error('Avatar could not be decoded');
// Fit the original portrait inside a white square without stretching or cropping.
const dimensions = source.getSize();
const side = 1024;
const scale = side / Math.max(dimensions.width, dimensions.height);
const width = Math.round(dimensions.width * scale);
const height = Math.round(dimensions.height * scale);
const resized = source.resize({ width, height, quality: 'best' }).toBitmap();
const square = Buffer.alloc(side * side * 4, 255);
const left = Math.floor((side - width) / 2);
const top = Math.floor((side - height) / 2);
for (let row = 0; row < height; row++) {
  resized.copy(square, ((top + row) * side + left) * 4, row * width * 4, (row + 1) * width * 4);
}
const avatar = nativeImage.createFromBitmap(square, { width: side, height: side });
const sizes = [16, 24, 32, 48, 64, 128, 256];
const entries = sizes.map(size => ({ size, png: avatar.resize({width:size,height:size,quality:'best'}).toPNG() }));
const header = Buffer.alloc(6 + entries.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
let offset = header.length;
entries.forEach(({size,png}, i) => {
  const pos = 6 + i * 16;
  header[pos] = size === 256 ? 0 : size; header[pos + 1] = header[pos];
  header.writeUInt16LE(1, pos + 4); header.writeUInt16LE(32, pos + 6);
  header.writeUInt32LE(png.length, pos + 8); header.writeUInt32LE(offset, pos + 12);
  offset += png.length;
});
fs.writeFileSync(path.join(root,'build/icon.ico'), Buffer.concat([header,...entries.map(e=>e.png)]));
fs.writeFileSync(path.join(root,'build/icon.png'), avatar.resize({width:256,height:256,quality:'best'}).toPNG());
fs.writeFileSync(path.join(root,'src/renderer/assets/logo.png'), avatar.resize({width:512,height:512,quality:'best'}).toPNG());
console.log('Created app PNG, renderer logo and ICO sizes: '+sizes.join(', '));

app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
