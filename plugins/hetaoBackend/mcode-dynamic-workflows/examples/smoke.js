await ctx.phase({id:'review',label:'并行审查'});
const schema={type:'object',properties:{hasIssue:{type:'boolean'},explanation:{type:'string'}},required:['hasIssue','explanation'],additionalProperties:false};
const reviews=await ctx.map(['空数组的返回值','常规输入的计算'],(focus,i)=>ctx.agent({
 id:'review:'+i,label:focus,phase:'review',schema,
 prompt:'这是工作流集成验证。只分析给定文本，不要调用任何工具，不要读取或修改文件。按 schema 返回简短中文结论，explanation 不超过 60 字。关注点：'+focus,
 input:{code:input.material}
}));
if(reviews.some(r=>r.status!=='succeeded'))return {reviews,summary:'存在执行缺口'};
await ctx.phase({id:'report',label:'形成结论'});
const report=await ctx.agent({id:'report',label:'汇总审查结果',phase:'report',dependsOn:['review:0','review:1'],
 schema:{type:'object',properties:{summary:{type:'string'}},required:['summary'],additionalProperties:false},
 prompt:'这是工作流集成验证。仅汇总传入的两条审查结果，不调用任何工具，不读取或修改文件。返回中文 summary，不超过 100 字。',input:{reviews}
});
return {reviews,report};
