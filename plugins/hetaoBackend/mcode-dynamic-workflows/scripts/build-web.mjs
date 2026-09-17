import {contentStyles} from '../web/readable.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
await build({entryPoints:['web/app.source.mjs'],outfile:'web/app.js',bundle:true,platform:'browser',format:'esm',target:'es2022',define:{DEFAULT_ENGLISH_EXAMPLE:JSON.stringify(await readFile('examples/audit-en.js','utf8'))}});

await writeFile('web/readable.css',contentStyles);
