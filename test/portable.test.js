import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

test('built download runs without node_modules, guides a new user, saves scope and connects without changing prior settings',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));const base=path.join(root,'.test-output');fs.mkdirSync(base,{recursive:true});
  const fixture=fs.mkdtempSync(path.join(base,'portable-'));const install=path.join(fixture,'Other User App');fs.mkdirSync(install);
  for(const dir of ['dist','web'])fs.cpSync(path.join(root,dir),path.join(install,dir),{recursive:true});
  const home=path.join(fixture,'Other User Data'),codex=path.join(fixture,'codex'),repos=path.join(fixture,'projects');fs.mkdirSync(codex);fs.mkdirSync(repos);
  const original='model = "example-model"\n# preserve this comment\n';fs.writeFileSync(path.join(codex,'config.toml'),original);
  const env={...process.env,GITHUB_MANAGER_HOME:home,CODEX_HOME:codex,GITHUB_MANAGER_SETTINGS:path.join(home,'settings.json')};
  const client=new Client({name:'portable-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(install,'dist/server.js')],cwd:install,env,stderr:'pipe'});
  let errorLog='';transport.stderr.on('data',b=>errorLog+=b);
  let session;
  try{
    await client.connect(transport);
    const list=()=>client.callTool({name:'list_local_github_items',arguments:{refresh:true}},undefined,{timeout:60000});
    assert.equal((await list()).structuredContent.needsSetup,true);
    const opened=await client.callTool({name:'open_local_github_panel',arguments:{}},undefined,{timeout:30000});assert.ok(!opened.isError,JSON.stringify(opened));
    const url=new URL(opened.structuredContent.url);const token=url.hash.slice(1);const post=(route,body)=>fetch(url.origin+'/api/'+route,{method:'POST',headers:{origin:url.origin,authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
    const setup=await(await post('setup',{})).json();assert.equal(setup.value.configured,false);assert.equal(setup.value.dataRoot,home);
    const values={gitRoots:[repos],downloadRoots:[],npmRoots:[],gitExecutable:'',dshProfile:codex};
    assert.equal((await post('setup/save',{...values,gitRoots:['relative']})).status,400);
    const saved=await(await post('setup/save',values)).json();assert.equal(saved.value.configured,true);
    const updated=(await list()).structuredContent;assert.equal(updated.needsSetup,undefined);assert.deepEqual(updated.scanRoots.git,[repos]);
    const shell=await fetch(url.origin);assert.match(await shell.text(),/setup-dialog/);
    execFileSync(process.execPath,[path.join(install,'dist/launcher.js'),'--connect'],{cwd:install,env,stdio:'pipe'});
    const config=fs.readFileSync(path.join(codex,'config.toml'),'utf8');assert.ok(config.startsWith(original));assert.match(config,/approval_mode = "prompt"/);assert.ok(config.includes(JSON.stringify(path.join(install,'dist/server.js'))));
    execFileSync(process.execPath,[path.join(install,'dist/launcher.js'),'--connect'],{cwd:install,env,stdio:'pipe'});assert.equal(fs.readFileSync(path.join(codex,'config.toml'),'utf8'),config);
    assert.ok(!fs.existsSync(path.join(install,'node_modules')));assert.ok(!fs.existsSync(path.join(install,'data')));
    session=JSON.parse(fs.readFileSync(path.join(home,'data/panel-session.json'),'utf8'));
    assert.equal(errorLog,'');
  }finally{await client.close();if(!session){try{session=JSON.parse(fs.readFileSync(path.join(home,'data/panel-session.json'),'utf8'));}catch{}}
    if(session&&Number.isInteger(session.pid))try{process.kill(session.pid);}catch{}
  }
});
