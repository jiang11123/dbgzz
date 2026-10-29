// Historical native grants derive from official committed tool results and the
// host journal's exact submission identity, never provider/user text.
export const nativeSourceKey = source => JSON.stringify(Object.fromEntries(Object.entries(source).filter(([key])=>key!=='originTurnId' && key!=='toolCallId').sort(([a],[b])=>a.localeCompare(b))));
export async function officialNativeHistory(entry, doc, context) {
  const view=await entry.root.context(context);
  const rounds=[];
  for(const turn of [...(doc.turns || []),...(doc.active ? [doc.active] : [])]) {
    if(!turn.turnId || !turn.requestId || (!turn.submissionId && turn!==doc.active)) continue;
    const submission=await entry.harness.commit(tx=>turn.submissionId ? tx.submission(turn.submissionId) : tx.submissionByRequest(entry.root.id,turn.requestId),context);
    if(!submission || submission.conversationId!==entry.root.id || submission.requestId!==turn.requestId || submission.entry===undefined) continue;
    // A failed/stopped generation can still have committed media tool results.
    // Keep its entry boundary and provenance; Go separately checks undo, scope
    // and the exact resource version before any historical bytes are dispatched.
    if(turn!==doc.active && !['done','unanswered'].includes(submission.status)) continue;
    rounds.push({turnId:turn.turnId,entryId:submission.entry,historical:turn!==doc.active});
  }
  rounds.sort((a,b)=>a.entryId-b.entryId);
  const origins=new Map();
  for(let i=0;i<rounds.length;i++){
    const round=rounds[i],upper=rounds[i+1]?.entryId ?? Infinity;
    for(const item of view.entries){
      if(item.id<=round.entryId || item.id>=upper) continue;
      for(const message of item.model || []){
        if(message.role!=='toolResult'||!/^media_(overview|inspect|check)$/.test(message.toolName||''))continue;
        for(const content of message.content||[])for(const line of String(content.text||'').split('\n')){
          const prefix=['BEEFTV_MEDIA_REF_V1:','BEEFTV_MEDIA_PART_V1:'].find(prefix=>line.startsWith(prefix));if(!prefix)continue;
          const part=JSON.parse(line.slice(prefix.length));
          if(!part.source || (part.source.originTurnId && part.source.originTurnId!==round.turnId))throw Error('native_history_origin_conflict');
          const key=`${message.toolCallId}:${nativeSourceKey(part.source)}`;
          const prior=origins.get(key);if(prior && prior.originTurnId!==round.turnId)throw Error('native_history_origin_ambiguous');
          origins.set(key,{originTurnId:round.turnId,historical:round.historical});
        }
      }
    }
  }
  return {origins,rounds};
}
