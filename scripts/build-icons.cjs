// Convert the approved avatar into app assets. Run with Electron in Node mode.
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(() => {
const root = path.resolve(__dirname, '..');
const avatar = nativeImage.createFromPath(path.join(root, 'build/brand-avatar.png'));
if (avatar.isEmpty()) throw new Error('Avatar could not be decoded');
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
