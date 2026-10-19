import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ImageAssetStore } from './image-assets';

test('assets survive original removal and restart, deduplicate, and delete only the library copy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-assets-'));
  try {
    const source = path.join(root, '参考.png');
    fs.writeFileSync(source, Buffer.from('test image'));
    const store = new ImageAssetStore(path.join(root, 'library'));
    const [item] = store.import([source, source]);
    assert.equal(store.list().length, 1);
    fs.unlinkSync(source);
    const restored = new ImageAssetStore(path.join(root, 'library'));
    assert.equal(restored.list()[0].name, '参考.png');
    assert.equal(fs.readFileSync(restored.resolve(item.id), 'utf8'), 'test image');
    assert.throws(() => restored.resolve('../outside.png'));
    restored.remove(item.id);
    assert.equal(restored.list().length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('selected assets retain requested order including repeated images',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'asset-order-'));
  try {
    const a=path.join(root,'a.png'),b=path.join(root,'b.png');
    fs.writeFileSync(a,'first');fs.writeFileSync(b,'second');
    const store=new ImageAssetStore(path.join(root,'library'));
    const imported=store.import([a,b,a],true);
    assert.deepEqual(imported.map(item=>item.name),['a.png','b.png','a.png']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('a file deleted between listing and stat is skipped, not fatal', () => {
  // The asset panel calls list() on every refresh; a file removed by another window
  // (or a half-finished copy) used to throw out of statSync and blank the panel.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-race-'));
  try {
    const source = path.join(root, 'x.png');
    fs.writeFileSync(source, 'bytes');
    const store = new ImageAssetStore(path.join(root, 'library'));
    store.import([source]);
    // Simulate the race: readdirSync sees the file, statSync finds it gone.
    const realReaddir = fs.readdirSync;
    (fs as any).readdirSync = (...args: any[]) => {
      const names = realReaddir(args[0] as string, ...(args.slice(1) as []));
      const id = names[0];
      if (id) fs.unlinkSync(path.join(root, 'library', id));
      return names;
    };
    try {
      assert.deepEqual(store.list(), []);
    } finally { (fs as any).readdirSync = realReaddir; }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});