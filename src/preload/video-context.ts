import { ipcRenderer } from 'electron';

let automatedSend = false;
let routing = false;
let attachmentFiles: File[] = [];
ipcRenderer.on('account-send:bypass', (_event, enabled) => { automatedSend = Boolean(enabled); });
window.addEventListener('change', event => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.type === 'file') attachmentFiles = [...(target.files || [])].filter(file => (file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name)));
}, true);

// Left click / Enter keep the site's own behavior. Cross-account sending is explicit on right click.
window.addEventListener('contextmenu', (event: MouseEvent) => {
  if (!event.isTrusted || automatedSend || !['www.doubao.com','www.dola.com','dola.com'].includes(location.hostname)) return;
  const input=[...document.querySelectorAll<HTMLElement>('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0);
  const button=event.target instanceof Element ? event.target.closest<HTMLElement>('button,[role=button]') : null;
  if (!input || !button) return;
  const label=[button.innerText,button.getAttribute('aria-label'),button.getAttribute('title'),button.getAttribute('data-testid')].join(' ').trim();
  const rect=input.getBoundingClientRect(), point=button.getBoundingClientRect();
  const named=/发送|send|submit|开始生成|立即生成|生成视频/i.test(label);
  const icon=!label && point.left>=rect.right-120 && point.top>=rect.top-80 && point.bottom<=rect.bottom+120;
  if (!named && !icon) return;
  event.preventDefault();event.stopImmediatePropagation();
  if (routing) return;
  routing=true;
  void (async()=>{
    try {
      const prompt=input instanceof HTMLTextAreaElement?input.value:input.innerText;
      const files=[...document.querySelectorAll<HTMLInputElement>('input[type=file]')].flatMap(n=>[...(n.files || [])]).filter(file=>(file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(file.name)));
      // Doubao clears file inputs after uploading and renders attachment cards beside
      // the text editor, rather than inside its immediate parent.
      const editorRect=input.getBoundingClientRect();
      let scope: HTMLElement | null=input.parentElement;
      let previews: HTMLImageElement[]=[];
      for(let level=0;scope && level<6;level++,scope=scope.parentElement) {
        previews=[...scope.querySelectorAll<HTMLImageElement>('img')].filter(img=>{
          const r=img.getBoundingClientRect();
          return r.width>20 && r.height>20 && r.bottom>=editorRect.top-260 && r.top<=editorRect.bottom+120
            && !img.closest('[data-message-id],[data-message-role],article');
        });
        if(previews.length || scope===document.body) break;
      }
      const previewCount=previews.length;
      // A single attachment can render several <img> layers. The main process
      // validates the logical preview count before allowing synchronization.
      const references=[];
      for (const file of (files.length?files:previewCount?attachmentFiles:[]).slice(0,12)) {
        if(file.size>30*1024*1024) throw new Error('参考图片超过 30 MB，请重新选择');
        const src=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=reject;reader.readAsDataURL(file);});
        references.push({src,name:file.name});
      }
      ipcRenderer.send('account-send:context',{prompt:prompt.trim(),references,previewCount,x:event.clientX,y:event.clientY});
    } catch(error) { ipcRenderer.send('account-send:failed',String(error)); }
    finally { routing=false; }
  })();
}, true);

// Receive real mouse events before the page's own context-menu handlers.
// No privileged API is exposed to the remote page.
window.addEventListener('contextmenu', (event: MouseEvent) => {
  if (!event.isTrusted) return;
  if (location.protocol !== 'https:' || location.hostname !== 'www.doubao.com') return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  let media = target.closest('video,img');
  if (!media) {
    let scope: Element | null = target;
    for (let level = 0; scope && level < 4; level++, scope = scope.parentElement) {
      const matches = [...scope.querySelectorAll('video,img')].filter(element => {
        const rect = element.getBoundingClientRect();
        return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      });
      if (matches.length === 1) { media = matches[0]; break; }
      const videos = matches.filter(element => element.tagName === 'VIDEO');
      if (matches.length === 2 && videos.length === 1) { media = videos[0]; break; }
      if (matches.length > 1 || scope.hasAttribute('data-message-id')) break;
    }
  }
  if (!media) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.send('doubao:video-context', {
    x: event.clientX, y: event.clientY,
    mediaType: media.tagName === 'VIDEO' ? 'video' : 'image',
  });
}, true);
