const {app,BrowserWindow,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'doubao-placeholder-'));app.setPath('userData',profile);
const timeout=setTimeout(()=>app.exit(1),40000);
app.whenReady().then(async()=>{
 const {chatImagesScript,draftImageStateScript,reimportOrderedImages}=require('../dist/main/main/chat-images.js');
 const {prepareText}=require('../dist/main/main/page-composer.js');
 const {assertVisibleImage}=require('../dist/main/main/image-data.js');
 const blank=nativeImage.createFromBitmap(Buffer.alloc(54*54*4),{width:54,height:54}).toPNG();
 const original=nativeImage.createFromBitmap(Buffer.from([80,160,240,255]),{width:1,height:1}).toPNG();
 const blankUrl='data:image/png;base64,'+blank.toString('base64');
 const originalUrl='data:image/png;base64,'+original.toString('base64');
 const originalFile=path.join(profile,'original.png');fs.writeFileSync(originalFile,original);
 const blankFile=path.join(profile,'blank.png');fs.writeFileSync(blankFile,blank);
 assert.throws(()=>assertVisibleImage(blank),/透明占位图/);assertVisibleImage(original);
 const win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{backgroundThrottling:false}});
 const page=`<!doctype html><style>#composer{position:absolute;left:100px;top:300px;width:700px}textarea{width:600px;height:100px}.attachment{position:absolute;top:-65px;width:54px;height:54px}.image-layer{position:absolute;inset:0;background-size:cover}img{position:absolute;inset:0;width:54px;height:54px}</style><div id="composer"><textarea></textarea><input type="file" accept="image/*"></div><script>
 window.files=[];window.pastes=0;
 window.addEventListener('paste',()=>window.pastes++);
 window.card=(url,index)=>{
 const card=document.createElement('div');card.className='attachment';card.style.left=(index*70)+'px';
 // Two render layers and an actual transparent placeholder reproduce the failure.
 for(let i=0;i<2;i++){const layer=document.createElement('div');layer.className='image-layer';layer.style.backgroundImage='url('+url+')';card.appendChild(layer);}
 const img=document.createElement('img');img.src=${JSON.stringify(blankUrl)};card.appendChild(img);
 document.getElementById('composer').prepend(card);
 };
 document.querySelector('input').onchange=async event=>{const file=event.target.files[0];window.files.push(Array.from(new Uint8Array(await file.arrayBuffer())));window.card(URL.createObjectURL(file),window.files.length-1);};
 </script>`;
 await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(page));
 const run=code=>win.webContents.executeJavaScript(code);
 await run(`window.card(${JSON.stringify(originalUrl)},0);window.card(${JSON.stringify(originalUrl)},1);true`);
 await new Promise(r=>setTimeout(r,100));
 const extracted=await run(chatImagesScript('draft'));
 assert.equal(extracted.length,2,'same file in separate cards must retain both positions');
 assert.ok(extracted.every(item=>item.src===originalUrl),'must select actual backgrounds, never transparent src');
 assert.equal((await run(draftImageStateScript)).count,2,'overlapping layers must not inflate attachment count');
 await run("document.querySelectorAll('.attachment').forEach(n=>n.remove())");
 await assert.rejects(reimportOrderedImages(win,[blankFile]),/透明占位图/);
 assert.equal(await run('window.files.length'),0,'reject blank before upload');
 await reimportOrderedImages(win,[originalFile,originalFile]);
 await prepareText(win,'你好，测试图片和文字一起同步');
 assert.equal(await run('document.querySelector("textarea").value'),'你好，测试图片和文字一起同步');
 assert.equal((await run(draftImageStateScript)).count,2);
 assert.equal(await run('window.pastes'),0);
 for(const bytes of await run('window.files'))assert.deepEqual(Buffer.from(bytes),original);
 const screenshot=path.join(profile,'synchronized.png');fs.writeFileSync(screenshot,(await win.webContents.capturePage()).toPNG());
 console.log('PASS: transparent placeholder rejected; CSS image layers extracted and counted once; two native uploads retain original bytes and order; text imported');console.log(screenshot);
 win.destroy();clearTimeout(timeout);app.quit();
}).catch(error=>{console.error(error);app.exit(1);});
