await ctx.phase({id:'scan',label:'分项审查'});
await ctx.phase({id:'verify',label:'独立复核'});
await ctx.phase({id:'report',label:'汇总报告'});
const schema={type:'object',properties:{summary:{type:'string'},findings:{type:'array',items:{type:'string'}}},required:['summary','findings'],additionalProperties:false};
const topics=['正确性','边界条件','可维护性'];
await ctx.log(`开始逐项审查与复核，共 ${topics.length} 个方向。`);
const rows=await ctx.map(topics,async (topic,i)=>{
  const auditId=`audit:${i}`,checkId=`verify:${i}`;
  await ctx.log(`开始审查：${topic}`,{stepId:auditId,phase:'scan'});
  const audit=await ctx.agent({id:auditId,label:topic,phase:'scan',schema,
    prompt:`仅审查输入材料的${topic}，不修改文件。指出有证据的问题；无法验证的情况说明限制。`,input:{topic,material:input.material}
  });
  if(audit.status!=='succeeded'){
    await ctx.log(`${topic} 审查失败，跳过本项复核：${audit.error}`,{stepId:auditId,phase:'scan'});
    return {topic,audit,check:null,checkId};
  }
  await ctx.log(`${topic} 审查完成，进入独立复核。`,{stepId:checkId,phase:'verify'});
  const check=await ctx.agent({id:checkId,label:`独立复核 · ${topic}`,phase:'verify',dependsOn:[auditId],schema,
    prompt:'独立核对前一轮结论与原始材料，保留有证据的发现，说明无法确认的内容。',input:{material:input.material,audit:audit.output}
  });
  await ctx.log(check.status==='succeeded'?`${topic} 复核完成，${check.output.findings.length} 条发现。`:`${topic} 复核失败：${check.error}`,{stepId:checkId,phase:'verify'});
  return {topic,audit,check,checkId};
});
const verified=rows.filter(row=>row.check?.status==='succeeded');
const missing=rows.filter(row=>row.check?.status!=='succeeded').map(row=>row.topic);
if(!verified.length)throw Error('没有成功的复核结果，不能生成已验证报告');
await ctx.log(`汇总 ${verified.length}/${topics.length} 个已复核方向，保留覆盖缺口。`,{stepId:'report',phase:'report'});
const report=await ctx.agent({id:'report',label:'汇总报告',phase:'report',dependsOn:verified.map(row=>row.checkId),schema,
  prompt:'合并已核查结论并去重，在 summary 中说明覆盖缺口。不要把不同 Agent 的一致意见当成事实证据。',input:{verified:verified.map(row=>row.check.output),missing}
});
if(report.status!=='succeeded')throw Error(report.error);
await ctx.log('汇总完成，可在最终报告中阅读并下载。',{stepId:'report',phase:'report'});
return {coverage:{topics:topics.length,verified:verified.length},report:report.output,limitations:missing};
