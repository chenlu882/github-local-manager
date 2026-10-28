import {build} from 'esbuild';
import fs from 'node:fs';
const entries={'server':'server.js','panel':'panel.js','launcher':'launcher.js','scan-worker':'core/scan-worker.js'};
const result=await build({entryPoints:entries,bundle:true,platform:'node',format:'esm',target:'node20',outdir:'dist',metafile:true,banner:{js:"import { createRequire as __createRequire } from 'node:module';const require = __createRequire(import.meta.url);"},legalComments:'eof'});
const packages=new Set(Object.keys(result.metafile.inputs).map(p=>p.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]).filter(Boolean));
let notices='Bundled third-party software licenses\n';
for(const name of [...packages].sort()){
  const dir='node_modules/'+name;const pkg=JSON.parse(fs.readFileSync(dir+'/package.json','utf8'));notices+='\n\n=== '+name+' '+pkg.version+' ===\n';
  const files=fs.readdirSync(dir).filter(n=>/^(license|copying|notice)/i.test(n)&&fs.statSync(dir+'/'+n).isFile());
  for(const file of files)notices+='\n'+fs.readFileSync(dir+'/'+file,'utf8')+'\n';
  if(!files.length)notices+='License declared by package: '+String(pkg.license||'See upstream package')+'\n';
}
fs.writeFileSync('THIRD_PARTY_NOTICES.txt',notices);
fs.writeFileSync('dist/package.json','{"type":"module"}\n');
console.log('Built standalone runtime; no node_modules needed in release.');
