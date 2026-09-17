import {createHash} from 'node:crypto';
import {realpath,stat} from 'node:fs/promises';
import {isAbsolute,relative,join,sep} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {TOOLS,createToolHandler} from './tools.mjs';

// The host launches MCP in the package directory, which is never a project default.
export const PROJECT_TOOLS=TOOLS.map(tool=>tool.name==='workflow_validate'?tool:{...tool,
 description:tool.description+' workspace 必须是当前任务项目的绝对路径，每次调用均须提供；不得使用插件安装目录。',
 inputSchema:{...tool.inputSchema,properties:{...tool.inputSchema.properties,workspace:{type:'string',minLength:1,description:'当前任务项目的绝对目录路径'}},required:[...(tool.inputSchema.required??[]),'workspace']}
});
export async function canonicalWorkspace(value,pluginRoot){
 if(typeof value!=='string'||!value.trim()||!isAbsolute(value))throw Error('WORKSPACE_REQUIRED: 请提供当前任务项目的绝对 workspace 路径；插件启动目录不是项目目录。');
 let workspace;
 try{workspace=await realpath(value);if(!(await stat(workspace)).isDirectory())throw Error('not a directory');}
 catch{throw Error('WORKSPACE_INVALID: workspace 必须是存在的本地目录。');}
 const root=await realpath(pluginRoot),rel=relative(root,workspace);
 if(!rel||(rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)))throw Error('WORKSPACE_PLUGIN_ROOT: 不能把插件安装目录或其子目录作为任务项目。');
 return workspace;
}
export function projectDataDir(base,workspace){return join(base,'projects',createHash('sha256').update(workspace).digest('hex'));}
export function createWorkspaceRouter({binary,pluginRoot,dataRoot,extraArgs=[]}){
 const connections=new Map();let closed=false;
 async function connect(workspace){
  const client=new Client({name:'workflow-project-router',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[binary,'--stdio','--workspace',workspace,'--data-dir',projectDataDir(dataRoot,workspace),...extraArgs],cwd:workspace,stderr:'pipe',env:{...process.env}});
  // Drain child diagnostics without mixing them into the parent MCP protocol.
  transport.stderr?.on('data',chunk=>process.stderr.write(chunk));
  try{await client.connect(transport);return client;}catch(error){await transport.close();throw error;}
 }
 return {
  async call(name,args={}){
   if(closed)throw Error('工作流连接已关闭');
   if(!TOOLS.some(t=>t.name===name))throw Error('未知工具');
   if(name==='workflow_validate')return createToolHandler(null,null)(name,args);
   const workspace=await canonicalWorkspace(args.workspace,pluginRoot);
   if(closed)throw Error('工作流连接已关闭');
   if(!connections.has(workspace)){
    const pending=connect(workspace);connections.set(workspace,pending);
    pending.catch(()=>{if(connections.get(workspace)===pending)connections.delete(workspace);});
   }
   const client=await connections.get(workspace);
   const {workspace:unused,...request}=args;
   const result=await client.callTool({name,arguments:request});
   const text=result.content?.find(item=>item.type==='text')?.text;
   if(result.isError)throw Error(text??'项目工作流调用失败');
   const value=JSON.parse(text);
   return name==='workflow_dashboard'?{...value,workspace}:value;
  },
  async close(){closed=true;await Promise.allSettled([...connections.values()].map(async pending=>(await pending).close()));connections.clear();}
 };
}
