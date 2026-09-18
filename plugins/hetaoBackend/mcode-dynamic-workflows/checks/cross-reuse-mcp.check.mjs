import test from 'node:test';import assert from 'node:assert/strict';import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
test('packaged MCP advertises reuseAcrossRuns and accepts it through the public tool surface',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'wf-cross-mcp-'));await writeFile(join(dir,'settings.json'),JSON.stringify({workspace:dir,dataDir:dir}));
 const client=new Client({name:'cross-reuse-mcp-test',version:'1'});const transport=new StdioClientTransport({command:process.execPath,args:[resolve('dist/main.mjs'),'--stdio','--settings',join(dir,'settings.json')],stderr:'pipe'});
 try{
  await client.connect(transport);const {tools}=await client.listTools();
  for(const name of ['workflow_start','workflow_update']){const tool=tools.find(t=>t.name===name);assert.ok(tool,`${name} listed`);assert.equal(tool.inputSchema.properties.reuseAcrossRuns?.type,'boolean',`${name} schema must advertise reuseAcrossRuns (additionalProperties:false)`);}
  const started=await client.callTool({name:'workflow_start',arguments:{requestId:'cross-mcp',name:'Cross-run via public surface',executor:'demo',reuseAcrossRuns:true,script:'return await ctx.agent({id:"a",prompt:"p"});'}});
  assert.ok(!started.isError,started.content?.[0]?.text);const run=JSON.parse(started.content[0].text);
  assert.equal(run.reuseAcrossRuns,true,'the flag must survive the public tool surface');
  const rejected=await client.callTool({name:'workflow_start',arguments:{requestId:'cross-mcp-bad',name:'Bad flag type',executor:'demo',reuseAcrossRuns:'yes',script:'return 1;'}});
  assert.ok(rejected.isError,'a non-boolean flag must be rejected by the public surface');
 }finally{await client.close();await transport.close();await rm(dir,{recursive:true,force:true});}
});
