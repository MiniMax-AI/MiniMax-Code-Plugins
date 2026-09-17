await ctx.phase({id:'scan',label:'Review'});
await ctx.phase({id:'verify',label:'Verify'});
await ctx.phase({id:'report',label:'Synthesize'});
const schema={type:'object',properties:{summary:{type:'string'},findings:{type:'array',items:{type:'string'}}},required:['summary','findings'],additionalProperties:false};
const topics=['correctness','boundary cases','maintainability'];
await ctx.log(`Starting independent review and verification for ${topics.length} topics.`);
const rows=await ctx.map(topics,async (topic,i)=>{
  const auditId=`audit:${i}`,checkId=`verify:${i}`;
  await ctx.log(`Reviewing ${topic}`,{stepId:auditId,phase:'scan'});
  const audit=await ctx.agent({id:auditId,label:topic,phase:'scan',schema,
    prompt:`Review the input for ${topic} without modifying files. Give evidence-backed findings and verification limits.`,input:{topic,material:input.material}
  });
  if(audit.status!=='succeeded'){
    await ctx.log(`${topic} review failed; skipping its verification: ${audit.error}`,{stepId:auditId,phase:'scan'});
    return {topic,audit,check:null,checkId};
  }
  await ctx.log(`${topic} reviewed; starting independent verification.`,{stepId:checkId,phase:'verify'});
  const check=await ctx.agent({id:checkId,label:`Verify · ${topic}`,phase:'verify',dependsOn:[auditId],schema,
    prompt:'Independently check the earlier findings against the original material. Retain supported findings and state what cannot be verified.',input:{material:input.material,audit:audit.output}
  });
  await ctx.log(check.status==='succeeded'?`${topic} verified; ${check.output.findings.length} findings.`:`${topic} verification failed: ${check.error}`,{stepId:checkId,phase:'verify'});
  return {topic,audit,check,checkId};
});
const verified=rows.filter(row=>row.check?.status==='succeeded');
const missing=rows.filter(row=>row.check?.status!=='succeeded').map(row=>row.topic);
if(!verified.length)throw Error('No verified results; cannot produce a verified report');
await ctx.log(`Synthesizing ${verified.length}/${topics.length} verified topics, preserving coverage gaps.`,{stepId:'report',phase:'report'});
const report=await ctx.agent({id:'report',label:'Synthesize',phase:'report',dependsOn:verified.map(row=>row.checkId),schema,
  prompt:'Synthesize verified findings, remove duplicates, and state coverage gaps in summary. Agreement between agents is not factual evidence.',input:{verified:verified.map(row=>row.check.output),missing}
});
if(report.status!=='succeeded')throw Error(report.error);
await ctx.log('Synthesis complete. Read or download the final report.',{stepId:'report',phase:'report'});
return {coverage:{topics:topics.length,verified:verified.length},report:report.output,limitations:missing};
