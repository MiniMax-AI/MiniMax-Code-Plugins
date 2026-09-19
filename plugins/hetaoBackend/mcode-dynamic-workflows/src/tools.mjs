import {assertValidDependencies} from './dependencies.mjs';
import {templateDefinition,METADATA_SCHEMA} from './definitions.mjs';
import { previewTopology } from './topology.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema,ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { LIMIT_SCHEMAS } from './limits.mjs';
import { validateScript,check,boundedJSON } from './common.mjs';
const obj=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'};const id={runId:string};
export const TOOLS=[
 {name:'workflow_validate',description:'静态检查脚本并生成结构拓扑，不执行脚本或 Agent。DSL: await ctx.phase({id,label}); await ctx.agent({id,label,phase,dependsOn,prompt,input,schema}); ctx.map(items,fn); ctx.log(message,{stepId,phase}); ctx.checkpoint(id,value)。dependsOn 可为单个 ID 字符串或 ID 数组，推荐数组；依赖须先成功。agent 返回 status/output/error；须显式处理失败。',inputSchema:obj({script:string},['script'])},
 {name:'workflow_start',description:'创建待审核工作流和结构拓扑，不执行 Agent。必须提供面板让用户审阅、修改并点击开始执行。mcode 模式会启动真实 MCode，会使用已登录身份与 smart 权限，不提供只读 OS 沙箱。demo 模式不调用模型。显式 requestId 幂等。',inputSchema:obj({requestId:string,name:string,script:string,input:{type:'object'},metadata:METADATA_SCHEMA,executor:{enum:['mcode','demo']},concurrency:{type:'integer',minimum:1,maximum:16},maxCalls:{type:'integer',minimum:1,maximum:100},reuseAcrossRuns:{type:'boolean',description:'Opt-in: adopt succeeded nodes from prior runs in the same workspace when context and spec hashes match'},...LIMIT_SCHEMAS},['requestId','name','script','executor'])},
 {name:'workflow_update',description:'修改待审核工作流的脚本、输入或预算并重建拓扑，保存后仍待审核；revision 必须匹配当前版本。不可修改已开始的运行。',inputSchema:obj({...id,revision:{type:'integer',minimum:1},reason:{type:'string',maxLength:2000},reuseStepIds:{type:'array',items:string,maxItems:100,uniqueItems:true},name:string,script:string,input:{type:'object'},metadata:METADATA_SCHEMA,executor:{enum:['mcode','demo']},concurrency:{type:'integer',minimum:1,maximum:16},maxCalls:{type:'integer',minimum:1,maximum:100},reuseAcrossRuns:{type:'boolean',description:'Opt-in: adopt succeeded nodes from prior runs in the same workspace when context and spec hashes match'},...LIMIT_SCHEMAS},['runId','revision'])},
 {name:'workflow_repair',description:'基于停止后的运行创建修复草稿，保留源运行；提供完整修复脚本、失败原因与 sourceUpdatedAt。显式 reuseStepIds 仅选择确认仍适用的成功节点，默认不复用。运行时重新校验输入、文件、参数与依赖；变更或重跑的上游使下游失效。必须打开面板交用户审核后开始，不能自动执行。',inputSchema:obj({...id,requestId:string,sourceUpdatedAt:{type:'integer'},script:string,reason:{type:'string',maxLength:2000},reuseStepIds:{type:'array',items:string,maxItems:100,uniqueItems:true},input:{type:'object'},...LIMIT_SCHEMAS,maxCalls:{type:'integer',minimum:1,maximum:100}},['runId','requestId','sourceUpdatedAt','script','reason'])},
 {name:'workflow_status',description:'读取运行状态、阶段和节点；输出不含完整 prompt/result。无 runId 时列出最近运行，默认返回数组（既有形状不变）。verifyIntegrity:true 时改返 {runs,integrityHeads,integrity} 对象形并全量重算两条完整性链；校验覆盖已锚定前缀，任何未锚定行 fail-closed（unchained>0 即 verified:false）。完整性是库内篡改证据信号，不是对抗能重写整库者的信任锚。',inputSchema:obj({...id,verifyIntegrity:{type:'boolean',description:'全量重算完整性链，返回 {runs,integrityHeads,integrity} 对象形（默认为纯数组）'}})},
 {name:'workflow_results',description:'分页读取节点结果；终态报告与失败明确分开。',inputSchema:obj({...id,includeDefinition:{type:'boolean'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:20}},['runId'])},
 {name:'workflow_wait',description:'按事件游标等待变化，最长25秒。需要继续关注时使用返回的nextSequence。',inputSchema:obj({...id,afterSequence:{type:'integer',minimum:0},timeoutMs:{type:'integer',minimum:0,maximum:25000}},['runId'])},
 {name:'workflow_cancel',description:'取消本插件工作流，等待在途 exec 退出；不取消其他 MCode 会话。',inputSchema:obj(id,['runId'])},
 {name:'workflow_pause',description:'停止派发并中断在途调用，保留已完成节点，可恢复。',inputSchema:obj(id,['runId'])},
 {name:'workflow_resume',description:'原脚本与原输入恢复，复用已成功节点。可调整 maxSteps/stepTimeoutMs/runTimeoutMs/maxCalls 后重试，成功节点复用，失败节点从头执行。异常退出需要用户先确认旧 Agent 已停止。',inputSchema:obj({...id,confirmStopped:{type:'boolean'},...LIMIT_SCHEMAS,maxCalls:{type:'integer',minimum:1,maximum:100}},['runId'])},
 {name:'workflow_dashboard',description:'返回可收藏的本机可视化面板地址，无需 token。服务独立于聊天会话，重启后复用端口。',inputSchema:obj({})}
];
export function summary(snapshot){return {...snapshot,script:undefined,input:undefined,fingerprints:undefined,requestHash:undefined,steps:snapshot.steps?.map(({prompt,input,output,rawOutput,requestHash,...s})=>s),result:undefined};}
export async function waitEvents(engine,runId,after=0,timeout=25000){engine.snapshot(runId);const get=()=>engine.store.events(runId,after,100);let events=get();if(!events.length&&engine.active.has(runId)&&timeout>0)await new Promise(resolve=>{const done=()=>{clearTimeout(timer);engine.off('change',listener);resolve();};const listener=e=>{if(e.runId===runId)done();};const timer=setTimeout(done,timeout);engine.on('change',listener);if(get().length)done();});events=get();return {events,nextSequence:events.at(-1)?.seq??after,status:engine.store.get(runId).status};}
export function createToolHandler(engine,getURL){return async(name,args={})=>{
 switch(name){
 case 'workflow_validate':return assertValidDependencies(previewTopology(args.script));
 case 'workflow_start':return summary(await engine.start(args));
 case 'workflow_update':return summary(await engine.update(args.runId,args));
 case 'workflow_repair':return summary(await engine.repair(args.runId,args));
 case 'workflow_status':if(args.runId)return summary(engine.snapshot(args.runId));if(args.verifyIntegrity===true)return {runs:engine.store.list().map(r=>summary(r)),integrityHeads:engine.store.integrityHeads(),integrity:engine.store.verifyIntegrity()};return engine.store.list().map(r=>summary(r));
 case 'workflow_results':{const r=engine.snapshot(args.runId);const offset=args.offset??0,limit=args.limit??10;check(Number.isInteger(offset)&&offset>=0&&Number.isInteger(limit)&&limit>=1&&limit<=20,'分页参数无效');return {status:r.status,updatedAt:r.updatedAt,...(args.includeDefinition?{definition:templateDefinition(r)}:{}),result:r.result,steps:r.steps.slice(offset,offset+limit).map(({prompt,input,...s})=>s),nextOffset:offset+limit<r.steps.length?offset+limit:null};}
 case 'workflow_wait':{const t=args.timeoutMs??25000,a=args.afterSequence??0;check(Number.isInteger(t)&&t>=0&&t<=25000&&Number.isInteger(a)&&a>=0,'等待参数无效');return waitEvents(engine,args.runId,a,t);}
 case 'workflow_cancel':return summary(await engine.stop(args.runId));
 case 'workflow_pause':return summary(await engine.stop(args.runId,'paused'));
 case 'workflow_resume':return summary(await engine.resume(args.runId,args));
 case 'workflow_dashboard':return {url:getURL(),localOnly:true};
 default:throw new Error('未知工具');}
};}
export async function startStdio(handler,tools=TOOLS){const server=new Server({name:'mcode-dynamic-workflows',version:'0.8.0'},{capabilities:{tools:{}}});server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));server.setRequestHandler(CallToolRequestSchema,async req=>{try{const value=await handler(req.params.name,req.params.arguments);return {content:[{type:'text',text:boundedJSON(value)}]};}catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}});await server.connect(new StdioServerTransport());return server;}
