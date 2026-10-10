const {app,nativeImage}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'doubao-image-order-')));process.env.CANVAS_BRIDGE_PORT='0';
app.on('web-contents-created',(_e,wc)=>{const load=wc.loadURL.bind(wc);wc.loadURL=(url,options)=>/^https:\/\/(www\.)?(doubao|dola)\.com\/?$/.test(url)?load('data:text/html,<textarea>fixture</textarea>',options):load(url,options);});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async(fn)=>{for(let i=0;i<100;i++){if(await fn())return;await delay(50);}throw new Error('condition timeout');};
const timeout=setTimeout(()=>app.exit(1),40000);let started=false;
app.on('browser-window-created',(_e,main)=>{if(started)return;started=true;main.webContents.once('did-finish-load',async()=>{try{
 main.setContentSize(1300,800);main.showInactive();main.focus();main.webContents.focus();
 const run=code=>main.webContents.executeJavaScript(code);
 const {ImageAssetStore}=require('../dist/main/main/image-assets.js');const store=new ImageAssetStore(path.join(app.getPath('userData'),'image-assets'));
 const ids=[];for(let i=0;i<4;i++){const file=path.join(app.getPath('userData'),`test-${i}.png`);fs.writeFileSync(file,nativeImage.createFromBitmap(Buffer.from([i*60,180,220,255]),{width:1,height:1}).toPNG());ids.push(store.import([file],true)[0].id);}
 await run(`window.workspace.addQuickImages(${JSON.stringify(ids)})`);await wait(()=>run('document.querySelectorAll(".asset-bar-thumb").length===4'));
 const rects=await run('[...document.querySelectorAll(".asset-bar-thumb")].map(n=>n.getBoundingClientRect().toJSON())');
 const selected=()=>run('[...document.querySelectorAll(".asset-bar-thumb")].map((n,i)=>n.querySelector("input").checked?i:null).filter(i=>i!==null)');
 const mouse=(type,x,y,mods=[])=>main.webContents.sendInputEvent({type,x:Math.round(x),y:Math.round(y),...(type==='mouseMove'?{modifiers:mods}:{button:'left',clickCount:1,modifiers:mods})});
 const drag=async(start,end,mods=[],escape=false)=>{
  mouse('mouseMove',start.x,start.y);mouse('mouseDown',start.x,start.y,mods);
  for(let i=1;i<=12;i++){mouse('mouseMove',start.x+(end.x-start.x)*i/12,start.y+(end.y-start.y)*i/12,[...mods,'leftButtonDown']);await delay(15);}
  assert.equal(await run('Boolean(document.querySelector(".image-selection-box"))'),true);
  if(escape){main.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});main.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});}
  mouse('mouseUp',end.x,end.y,mods);await delay(70);
  assert.equal(await run('Boolean(document.querySelector(".image-selection-box"))'),false);
 };
 const gap=i=>({x:rects[i].right+3,y:rects[i].top+4});
 await drag(gap(1),{x:rects[0].left+4,y:rects[0].bottom-4});assert.deepEqual(await selected(),[0,1]);
 await drag(gap(3),{x:rects[3].left+4,y:rects[3].bottom-4},['control']);assert.deepEqual(await selected(),[0,1,3]);
 await drag(gap(2),{x:rects[2].left+4,y:rects[2].bottom-4});assert.deepEqual(await selected(),[2]);
 await drag(gap(1),{x:rects[0].left+4,y:rects[0].bottom-4},[],true);assert.deepEqual(await selected(),[2]);
 const checkbox=await run('document.querySelector(".asset-bar-thumb input").getBoundingClientRect().toJSON()');mouse('mouseDown',checkbox.x+5,checkbox.y+5);mouse('mouseUp',checkbox.x+5,checkbox.y+5);await delay(70);assert.deepEqual(await selected(),[0,2]);
 const blank={x:rects[3].right+80,y:rects[3].top+10};mouse('mouseDown',blank.x,blank.y);mouse('mouseUp',blank.x,blank.y);await delay(70);assert.deepEqual(await selected(),[]);
 await drag(gap(1),{x:rects[0].left+4,y:rects[0].bottom-4});

 await run('document.querySelectorAll(".asset-bar-controls button")[1].click()');await delay(50);
 const order=()=>run('[...document.querySelectorAll(".asset-bar-thumb")].map(n=>n.dataset.assetId)');
 const moveCard=async(from,to)=>{
  const rects=await run('[...document.querySelectorAll(".asset-bar-thumb")].map(n=>n.getBoundingClientRect().toJSON())');
  const start={x:rects[from].left+rects[from].width/2,y:rects[from].top+rects[from].height/2};
  const end={x:to>from?rects[to].right-3:rects[to].left+3,y:start.y};
  mouse('mouseDown',start.x,start.y);
  for(let i=1;i<=12;i++){mouse('mouseMove',start.x+(end.x-start.x)*i/12,start.y,['leftButtonDown']);await delay(15);}
  mouse('mouseUp',end.x,end.y);await delay(150);
 };
 await moveCard(0,3);assert.deepEqual(await order(),[ids[1],ids[2],ids[3],ids[0]]);
 await moveCard(3,1);assert.deepEqual(await order(),[ids[1],ids[0],ids[2],ids[3]]);
 const {WorkspaceDatabase}=require('../dist/main/main/database.js');
 assert.deepEqual(JSON.parse(new WorkspaceDatabase().getSetting('quickImageIds')),await order());
 await assert.rejects(run(`window.workspace.reorderQuickImages(${JSON.stringify([ids[0],ids[0],ids[1],ids[2]])})`));
 // Reload the renderer to prove that saved order is loaded, rather than file-name order.
 main.webContents.reload();await new Promise(r=>main.webContents.once('did-finish-load',r));
 await wait(()=>run('document.querySelectorAll(".asset-bar-thumb").length===4'));
 assert.deepEqual(await order(),[ids[1],ids[0],ids[2],ids[3]]);
 await run('document.querySelectorAll(".asset-bar-thumb input")[0].click();document.querySelectorAll(".asset-bar-thumb input")[1].click()');await delay(50);
 await moveCard(0,3);assert.deepEqual(await order(),[ids[2],ids[3],ids[1],ids[0]]);
 // Exercise the native-file handoff, capturing startDrag arguments without a blocking OS drag loop.
 let nativeFiles;main.webContents.startDrag=options=>{nativeFiles=options.files;};
 const card=await run('document.querySelectorAll(".asset-bar-thumb")[2].getBoundingClientRect().toJSON()');
 const bar=await run('document.querySelector(".image-assets-bar").getBoundingClientRect().toJSON()');
 mouse('mouseDown',card.x+card.width/2,card.y+card.height/2);
 mouse('mouseMove',card.x+card.width/2,bar.bottom+8,['leftButtonDown']);
 await wait(()=>nativeFiles);mouse('mouseUp',card.x+card.width/2,bar.bottom+8);
 assert.deepEqual(nativeFiles.map(file=>path.basename(file)),[ids[1],ids[0]]);
 assert.deepEqual(await order(),[ids[2],ids[3],ids[1],ids[0]]);
 const screenshot=path.join(app.getPath('userData'),'sorted.png');fs.writeFileSync(screenshot,(await main.webContents.capturePage()).toPNG());
 console.log('PASS: real mouse forward/backward reorder, selected-group move, persisted order after reload, invalid request rejected, native-file handoff preserves visual order; marquee remains functional');console.log(screenshot);
 clearTimeout(timeout);app.quit();
 }catch(error){console.error(error);app.exit(1);}});});
require('../dist/main/main/main.js');
