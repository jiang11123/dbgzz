// Shared by source extraction and destination confirmation. A preview may have
// several overlapping DOM layers, including a transparent <img> placeholder.
export const attachmentDomScript = `
  const input=[...document.querySelectorAll('[contenteditable=true],textarea')].find(n=>n.getBoundingClientRect().width>0);
  const messages='[data-message-id],[data-message-role],[data-testid*=message],[class*=message-item],[class*=user-message]';
  const background=n=>{const match=/^url\\(["']?(.*?)["']?\\)$/.exec(getComputedStyle(n).backgroundImage);return match?.[1] || '';};
  const transparent=n=>{
    if(!n.complete || !n.naturalWidth || n.naturalWidth*n.naturalHeight>65536)return false;
    try{
      const canvas=document.createElement('canvas');canvas.width=n.naturalWidth;canvas.height=n.naturalHeight;
      const ctx=canvas.getContext('2d');ctx.drawImage(n,0,0);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      for(let i=3;i<pixels.length;i+=4)if(pixels[i])return false;
      return true;
    }catch{return false;}
  };
  const collect=()=>{
    if(!input)return [];
    const r=input.getBoundingClientRect();
    const candidates=[];
    for(const n of document.querySelectorAll('img,[style*=background],[class*=image],[class*=Image]')){
      const b=n.getBoundingClientRect(),style=getComputedStyle(n);
      if(b.width<=24 || b.height<=24 || b.right<r.left-80 || style.visibility==='hidden' || Number(style.opacity)===0
        || n.closest('aside,nav,header,[role=navigation]') || /avatar|头像|icon|logo/i.test(String(n.className)+' '+(n.alt || '')))continue;
      const bg=background(n);
      const isImage=n.tagName==='IMG';
      const blank=isImage && transparent(n);
      const src=bg || (isImage && !blank ? n.currentSrc || n.src : '');
      if(!src)continue;
      candidates.push({node:n,src,rect:b,ready:bg?false:Boolean(n.complete && n.naturalWidth>0),background:Boolean(bg)});
    }
    // Count a single on-screen attachment once, even if its wrapper, thumbnail
    // and overlay each expose an image URL. Separate equal files stay separate.
    const result=[];
    for(const item of candidates){
      const b=item.rect;
      const duplicate=result.findIndex(other=>{
        const a=other.rect;
        const overlap=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
        return overlap/Math.max(a.width*a.height,b.width*b.height)>.85;
      });
      if(duplicate<0)result.push(item);
      else if(item.ready && !result[duplicate].ready)result[duplicate]=item;
    }
    return result;
  };
  const isDraft=item=>!item.node.closest(messages) && item.rect.bottom>=input.getBoundingClientRect().top-360 && item.rect.top<=input.getBoundingClientRect().bottom+100;
`;
