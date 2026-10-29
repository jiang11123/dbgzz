import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Tests use a file-backed stand-in for the separate Go database. Instructions
// remain in the package fixture; this file stores only identities and receipts.
export function fixtureSkillContext(directory) {
  const file=path.join(directory,'active-skill-context.json');
  const load=()=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  const save=state=>fs.writeFileSync(file,JSON.stringify(state));
  const get=(entry,state)=>state[entry.sessionId] ||= {context:{canvasId:entry.canvasId,sessionId:entry.sessionId,
    scopeId:crypto.randomUUID(),revision:0,activePins:[],lifecycle:'active'},receipts:{}};
  return {
    readContext:async entry=>{const state=load();const value=get(entry,state);save(state);return structuredClone(value.context);},
    changeContext:async(entry,change)=>{
      const state=load();const value=get(entry,state);const context=value.context;
      if(change.action==='ack_reset') {context.lifecycle='active';save(state);return structuredClone(context);}
      if(value.receipts[change.requestId])return structuredClone(value.receipts[change.requestId]);
      if(change.expectedRevision!==context.revision)throw Object.assign(Error('skill_context_revision_conflict'),{reason:'skill_context_revision_conflict'});
      if(change.action==='activate'||change.action==='new_scope')context.activePins=change.pins || [];
      if(change.action==='clear')context.activePins=[];
      if(change.action==='new_scope'){context.scopeId=crypto.randomUUID();context.lifecycle='reset_pending';}
      context.revision++;
      value.receipts[change.requestId]=structuredClone(context);save(state);return structuredClone(context);
    },
  };
}

export function serveEmptySkillContext(req,res) {
  const url=new URL(req.url,'http://fixture.local');
  const match=/^\/api\/assistant\/runtime\/canvases\/([^/]+)\/skill-context$/.exec(url.pathname);
  if(!match || req.method!=='GET')return false;
  res.end(JSON.stringify({code:0,data:{canvasId:decodeURIComponent(match[1]),sessionId:url.searchParams.get('sessionId'),scopeId:'fixture-empty-scope',revision:0,activePins:[],lifecycle:'active'}}));
  return true;
}
