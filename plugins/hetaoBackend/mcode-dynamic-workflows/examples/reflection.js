await ctx.phase({id:'draft',label:'初稿'});
await ctx.phase({id:'critique',label:'独立批判'});
await ctx.phase({id:'revise',label:'修订定稿'});
const schema={type:'object',properties:{text:{type:'string'},openIssues:{type:'array',items:{type:'string'}}},required:['text','openIssues'],additionalProperties:false};
await ctx.log('反思编队：初稿、批判、修订由互相独立的 Agent 承担，修订者同时看到两份上游输出。',{phase:'draft'});
const draft=await ctx.agent({id:'draft',label:'初稿',phase:'draft',schema,
  prompt:'根据输入任务与材料写出一版初稿。证据不足之处如实写入 openIssues，不要编造。',input:{task:input.task,material:input.material}});
if(draft.status!=='succeeded')throw Error(draft.error);
await ctx.checkpoint('draft-snapshot',draft.output);
await ctx.log('初稿完成并冻结快照，进入独立批判。',{stepId:'critique',phase:'critique'});
const critique=await ctx.agent({id:'critique',label:'独立批判',phase:'critique',dependsOn:['draft'],schema,
  prompt:'只挑毛病：核对初稿与原始材料，指出无证据的断言与遗漏，写入 openIssues；不要重写初稿。',input:{material:input.material,draft:draft.output}});
if(critique.status!=='succeeded')throw Error(critique.error);
const revise=await ctx.agent({id:'revise',label:'修订定稿',phase:'revise',dependsOn:['draft','critique'],schema,
  prompt:'针对批判意见逐条修订初稿；不采纳的意见保留在 openIssues 中并说明理由。',input:{draft:draft.output,critique:critique.output}});
if(revise.status!=='succeeded')throw Error(revise.error);
await ctx.log(`定稿完成，遗留问题 ${revise.output.openIssues.length} 条。`,{stepId:'revise',phase:'revise'});
return {text:revise.output.text,openIssues:revise.output.openIssues,critiqueCount:critique.output.openIssues.length};
