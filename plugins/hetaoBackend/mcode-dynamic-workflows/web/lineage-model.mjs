// Pure model for the rerun-lineage panel's compare controls. The member
// selects and the diff box carry user interaction state (chosen pair, open
// comparison), so they may only be rebuilt when member identity changes;
// live member data (status, duration, trash/archive flags, preview)
// refreshes through the member cards on every render instead.
export function compareSignature(language,members){
 return JSON.stringify([language,...(members??[]).map(member=>[member.id,member.rerunSeq,member.name])]);
}
export function shouldRebuildCompare(previous,next){
 return previous!==next;
}
