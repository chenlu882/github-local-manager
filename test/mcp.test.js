import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { compareVersions } from '../core/version.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const out=path.join(root,'.test-output');fs.mkdirSync(out,{recursive:true});
const temp=fs.mkdtempSync(path.join(out,'run-'));
const dir=name=>{const p=path.join(temp,name);fs.mkdirSync(p,{recursive:true});return p;};
const repos=dir('repos'), downloads=dir('downloads'), npmRoot=dir('npm'), codex=dir('codex'), profile=dir('dsh');
const json=(p,value)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(value));};
json(path.join(npmRoot,'node_modules','example-tool','package.json'),{name:'example-tool',version:'1.0.0',bin:{example:'cli.js'},repository:'https://github.com/example/tool'});
json(path.join(codex,'plugins/cache/example-market/example/10.0.0/.codex-plugin/plugin.json'),{name:'example',version:'10.0.0'});
json(path.join(codex,'plugins/cache/example-market/example/9.0.0/.codex-plugin/plugin.json'),{name:'example',version:'9.0.0'});
fs.writeFileSync(path.join(codex,'config.toml'),'[plugins."example@example-market"]\nenabled = false # retain comments\n');
json(path.join(profile,'package.json'),{dependencies:{'@local/test':'link:local'},dsh:{profile:{bundles:['@local/test']}}});
json(path.join(profile,'node_modules/@local/test/package.json'),{name:'@local/test',version:'1.0.0',dsh:{bundle:{patch:'./patch.yml'}}});
fs.writeFileSync(path.join(downloads,'example-main.zip'),'test fixture');
const settings=path.join(temp,'settings.json');json(settings,{gitRoots:[repos],downloadRoots:[downloads],npmRoots:[npmRoot],dshProfile:profile,gitExecutable:''});
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']}).trim();
const seed=path.join(repos,'seed'), repo=path.join(repos,'project'), bare=path.join(temp,'remote.git');fs.mkdirSync(seed);
git(temp,'init','--bare',bare);git(seed,'init','-b','main');git(seed,'config','user.name','Test');git(seed,'config','user.email','test@example.invalid');
fs.writeFileSync(path.join(seed,'file'),'initial');git(seed,'add','.');git(seed,'commit','-m','initial');git(seed,'remote','add','origin',bare);git(seed,'push','-u','origin','main');git(repos,'clone','--branch','main',bare,repo);
const remote='https://github.com/example/local-mcp-test';git(repo,'remote','set-url','origin',remote);git(repo,'config',`url.${bare.replaceAll('\\','/')}.insteadOf`,remote);

const client=new Client({name:'manager-test',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'server.js')],cwd:root,
  env:{...process.env,GITHUB_MANAGER_SETTINGS:settings,CODEX_HOME:codex,APPDATA:dir('appdata')},stderr:'pipe'});
let errors='';transport.stderr.on('data',b=>errors+=b);
await client.connect(transport);
test.after(async()=>{await client.close();assert.equal(errors,'');});
const call=(name,args={})=>client.callTool({name,arguments:args},undefined,{timeout:60000});

test('actual stdio MCP initializes and exposes six scoped tools',async()=>{
  const tools=await client.listTools();assert.equal(tools.tools.length,6);
  assert.ok(!tools.tools.some(t=>/uninstall|command|delete/.test(t.name)));
  assert.equal(tools.tools.find(t=>t.name==='apply_local_update').annotations.destructiveHint,true);
});
test('all five categories, cache ordering, TOML comments and pagination',async()=>{
  const result=await call('list_local_github_items',{refresh:true,limit:100});assert.ok(!result.isError,JSON.stringify(result));
  const data=result.structuredContent;assert.deepEqual(data.counts,{dsh:1,tool:1,codex:1,git:1,download:1});
  const plugin=data.items.find(v=>v.kind==='codex');assert.equal(plugin.version,'10.0.0');assert.equal(plugin.enabled,false);
  const filtered=await call('list_local_github_items',{category:'tool',query:'example'});assert.equal(filtered.structuredContent.total,1);
  const paged=await call('list_local_github_items',{limit:2});assert.equal(paged.structuredContent.nextOffset,2);
});
test('invalid inputs and invented plans cannot trigger modifications',async()=>{
  const invalid=await call('check_local_update',{type:'tool',id:'invented'});assert.equal(invalid.isError,true);
  const bad=await call('apply_local_update',{planId:'00000000-0000-4000-8000-000000000000',confirmationText:'yes'});assert.equal(bad.isError,true);
  const wrongCategory=await call('check_local_update',{type:'codex',id:'anything'});assert.equal(wrongCategory.isError,true);
});
test('real local Git MCP: check, plan, exact confirmation, fast-forward, single use, dirty tree',async()=>{
  fs.writeFileSync(path.join(seed,'file'),'second');git(seed,'add','.');git(seed,'commit','-m','second');git(seed,'push');
  const checked=await call('check_local_update',{type:'git',id:repo});assert.equal(checked.structuredContent.hasUpdate,true);
  assert.equal(checked.structuredContent.ticket,undefined);assert.equal(git(repo,'rev-parse','HEAD')===git(seed,'rev-parse','HEAD'),false);
  const ready=await call('prepare_local_update',{type:'git',id:repo});assert.ok(!ready.isError,JSON.stringify(ready));const plan=ready.structuredContent;
  const denied=await call('apply_local_update',{planId:plan.planId,confirmationText:'yes'});assert.equal(denied.isError,true);
  const applied=await call('apply_local_update',{planId:plan.planId,confirmationText:plan.confirmationText});assert.ok(!applied.isError,JSON.stringify(applied));assert.equal(git(repo,'rev-parse','HEAD'),git(seed,'rev-parse','HEAD'));
  const reused=await call('apply_local_update',{planId:plan.planId,confirmationText:plan.confirmationText});assert.equal(reused.isError,true);
  fs.writeFileSync(path.join(repo,'untracked'),'local');const dirty=await call('prepare_local_update',{type:'git',id:repo});assert.equal(dirty.isError,true);assert.match(dirty.content[0].text,/未提交|未跟踪/);
});
test('SemVer keeps stable releases newer than release candidates',()=>{assert.equal(compareVersions('1.0.0','1.0.0-rc.1'),1);});
