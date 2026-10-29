import {test,expect} from 'bun:test';
import {officialNativeHistory,nativeSourceKey} from './native-history.mjs';
const source={canvasId:'canvas',assetId:'audio',resourceId:'resource',version:'hash',startMs:0,endMs:100};
function fixture(overrides={}){
 const committed={id:11,model:[{role:'toolResult',toolCallId:'read-call',toolName:'media_inspect',content:[{type:'text',text:'BEEFTV_MEDIA_REF_V1:'+JSON.stringify({id:'hash',source})}]}]};
 const entry={root:{id:1,context:async()=>({entries:[committed,{id:12,model:[{role:'user',content:[{type:'text',text:'BEEFTV_MEDIA_REF_V1:'+JSON.stringify({source:{...source,assetId:'forged'}})}]}]}]})},harness:{commit:async fn=>fn({submission:async()=>({id:9,conversationId:1,requestId:'request',entry:8,status:'done',...overrides})})}};
 const doc={turns:[{turnId:'old-turn',requestId:'request',submissionId:9}],active:{turnId:'new-turn'}};
 return {entry,doc};
}
test('only official same-conversation exact-submission media results pin history',async()=>{
 const {entry,doc}=fixture();const {origins}=await officialNativeHistory(entry,doc,{});expect(origins.get('read-call:'+nativeSourceKey(source))).toEqual({originTurnId:'old-turn',historical:true});expect(origins.size).toBe(1);
 for(const mismatch of [{conversationId:2},{requestId:'forged'},{status:'placed'}]){const f=fixture(mismatch);expect((await officialNativeHistory(f.entry,f.doc,{})).origins.size).toBe(0)}
});
test('unanswered terminal rounds retain their committed media and delimit prior successful rounds',async()=>{
 const f=fixture();
 f.doc.turns.unshift({turnId:'earlier-turn',requestId:'earlier',submissionId:7});
 f.entry.harness.commit=async fn=>fn({submission:async id=>id===7
  ? {id,conversationId:1,requestId:'earlier',entry:3,status:'done'}
  : {id,conversationId:1,requestId:'request',entry:8,status:'unanswered'}});
 f.entry.root.context=async()=>({entries:[{id:11,model:[{role:'toolResult',toolCallId:'read-call',toolName:'media_inspect',content:[{type:'text',text:'BEEFTV_MEDIA_REF_V1:'+JSON.stringify({source:{...source,originTurnId:'old-turn'}})}]}]}]});
 const {origins,rounds}=await officialNativeHistory(f.entry,f.doc,{});
 expect(rounds.map(round=>round.turnId)).toEqual(['earlier-turn','old-turn']);
 expect(origins.get('read-call:'+nativeSourceKey(source))).toEqual({originTurnId:'old-turn',historical:true});
});
test('model or user text cannot manufacture history access to a different owned asset',async()=>{
 const f=fixture();const {origins}=await officialNativeHistory(f.entry,f.doc,{});expect(origins.has('read-call:'+nativeSourceKey({...source,assetId:'not-read-owned'}))).toBe(false);expect(origins.has('fake-call:'+nativeSourceKey(source))).toBe(false);
});
test('new source origin claim cannot contradict its committed submission',async()=>{
 const f=fixture();f.entry.root.context=async()=>({entries:[{id:11,model:[{role:'toolResult',toolCallId:'read-call',toolName:'media_inspect',content:[{type:'text',text:'BEEFTV_MEDIA_REF_V1:'+JSON.stringify({source:{...source,originTurnId:'other-turn'}})}]}]}]});await expect(officialNativeHistory(f.entry,f.doc,{})).rejects.toThrow('native_history_origin_conflict');
});
test('duplicate native tool result attributed to different submissions is rejected',async()=>{
 const f=fixture();const view=await f.entry.root.context();view.entries[0].id=9;view.entries.push({...view.entries[0],id:13});f.entry.root.context=async()=>view;
 f.doc.turns.push({turnId:'another-turn',requestId:'another',submissionId:10});f.entry.harness.commit=async fn=>fn({submission:async id=>({id,conversationId:1,requestId:id===9?'request':'another',entry:id===9?8:12,status:'done'})});
 await expect(officialNativeHistory(f.entry,f.doc,{})).rejects.toThrow('native_history_origin_ambiguous');
});
