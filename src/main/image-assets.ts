import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { ImageAsset } from '../shared/types';

export class ImageAssetStore {
  constructor(private root: string) { fs.mkdirSync(root, { recursive: true }); }
  list(): ImageAsset[] {
    return fs.readdirSync(this.root).filter(name => /^[a-f0-9]{64}\.(png|jpg|jpeg|webp|gif|pdf|txt|csv|docx?|xlsx?|pptx?|md|markdown|mobi|epub|json|ya?ml|xml|html?|css|js|jsx|ts|tsx|py|java|go|rs|c|cpp|h|hpp|sh|bat|mp3|wav|m4a|flac|aac|ogg)$/i.test(name)).map(id => {
      const file = path.join(this.root, id);
      let name = id;
      try { name = JSON.parse(fs.readFileSync(`${file}.json`, 'utf8')).name || id; } catch { /* recover copied files */ }
      let size = 0;
      try { size = fs.statSync(file).size; } catch { return null; }
      return { id, name, url: pathToFileURL(file).toString(), size };
    }).filter((item): item is ImageAsset => item !== null)
  }
  resolve(id: string) {
    if (!this.list().some(item => item.id === id)) throw new Error('图片资产不存在，请刷新资产库');
    return path.join(this.root, id);
  }
  import(files: string[], onlySelection = false) {
    // Validate the entire selection before copying any files. Doubao's own upload input
    // accepts documents, code and audio alongside images, so the store mirrors that list.
    const allowed = /^(\.(png|jpg|jpeg|webp|gif|pdf|txt|csv|docx?|xlsx?|pptx?|md|markdown|mobi|epub|json|ya?ml|xml|html?|css|js|jsx|ts|tsx|py|java|go|rs|c|cpp|h|hpp|sh|bat|mp3|wav|m4a|flac|aac|ogg))$/i;
    const entries = files.map(file => {
      const ext = path.extname(file).toLowerCase();
      if (!allowed.test(ext)) throw new Error('不支持的文件类型：' + ext);
      const bytes = fs.readFileSync(file);
      if (!bytes.length || bytes.length > 30 * 1024 * 1024) throw new Error('文件不能为空，且每个最多 30 MB');
      return { file, bytes, id: createHash('sha256').update(bytes).digest('hex') + ext };
    });
    for (const entry of entries) {
      const destination = path.join(this.root, entry.id);
      if (fs.existsSync(destination)) continue;
      fs.writeFileSync(destination, entry.bytes);
      fs.writeFileSync(`${destination}.json`, JSON.stringify({ name: path.basename(entry.file) }));
    }
    const items = this.list();
    return onlySelection ? entries.map(entry => items.find(item => item.id === entry.id)!) : items;
  }
  remove(id: string) {
    const file = this.resolve(id);
    fs.unlinkSync(file);
    fs.rmSync(`${file}.json`, { force: true });
    return this.list();
  }
}
