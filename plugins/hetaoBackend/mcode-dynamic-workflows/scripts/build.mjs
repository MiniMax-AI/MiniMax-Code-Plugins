import './build-web.mjs';
import {build} from 'esbuild';
import {mkdir,readFile,writeFile,readdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';

// Dependencies are development-only. Installed plugins use the committed dist files.
await mkdir('dist',{recursive:true});
const packages=new Set(['@jitl/quickjs-wasmfile-release-sync']);
for(const entry of ['main','sandbox']){
 const result=await build({metafile:true,entryPoints:[`src/${entry}.mjs`],outfile:`dist/${entry}.mjs`,bundle:true,platform:'node',format:'esm',target:'node22',banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"},minify:false});
 for(const path of Object.keys(result.metafile.inputs)){
  const name=path.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];if(name)packages.add(name);
 }
}
const vendor=await readFile('node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm');
const hash=b=>createHash('sha256').update(b).digest('hex');
if(hash(vendor)!==hash(await readFile('src/quickjs.wasm')))throw Error('QuickJS asset differs from the pinned dependency');
await copyFile('src/quickjs.wasm','dist/quickjs.wasm');
let notices='Bundled runtime dependency licenses\n\n';
for(const name of [...packages].sort()){
 const base=resolve('node_modules',name),files=await readdir(base),license=files.find(f=>/^LICENSE/i.test(f));
 if(!license)throw Error(`Missing license for ${name}`);
 notices+=`\n--- ${name} ---\n${await readFile(join(base,license),'utf8')}\n`;
}
await writeFile('THIRD_PARTY_NOTICES.txt',notices);
console.log('Built Workflow Studio (no installer or runtime dependency download).');
