import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {parse} from 'smol-toml';
import {openPanel} from './panel-control.js';
import {APP_ROOT,ROOT} from './paths.js';
import {getSetup,core} from './manager.js';

export function connectCodex(){
  const directory=process.env.CODEX_HOME || path.join(os.homedir(),'.codex');
  fs.mkdirSync(directory,{recursive:true});const config=path.join(directory,'config.toml');
  const before=fs.existsSync(config)?fs.readFileSync(config,'utf8'):'';const parsed=parse(before);
  const entry=parsed.mcp_servers?.github_local_manager;
  const server=path.join(APP_ROOT,'dist','server.js');
  if(entry){if(entry.command===process.execPath&&entry.args?.[0]===server)return {alreadyConnected:true};throw Error('已有同名管理器，未覆盖。请先在 Codex MCP 设置中确认旧接入项。');}
  const backupDir=path.join(ROOT,'backups');fs.mkdirSync(backupDir,{recursive:true});
  if(before)fs.copyFileSync(config,path.join(backupDir,'codex-'+Date.now()+'.toml'));
  const block='\n[mcp_servers.github_local_manager]\ncommand = '+JSON.stringify(process.execPath)+'\nargs = ['+JSON.stringify(server)+']\ncwd = '+JSON.stringify(APP_ROOT)+'\nstartup_timeout_sec = 20\ntool_timeout_sec = 420\nrequired = false\n\n[mcp_servers.github_local_manager.env]\nGITHUB_MANAGER_HOME = '+JSON.stringify(ROOT)+'\n\n[mcp_servers.github_local_manager.tools.apply_local_update]\napproval_mode = "prompt"\n';
  parse(before+block);fs.writeFileSync(config,before+block);return {connected:true,config};
}
if(!process.env.GITHUB_MANAGER_TEST_IMPORT){
try{
  if(Number(process.versions.node.split('.')[0])<20)throw Error('需要 Node.js 20 或更高版本。');
  if(process.argv.includes('--check'))console.log(JSON.stringify(getSetup(),null,2));
  else if(process.argv.includes('--connect')){console.log(JSON.stringify(connectCodex()));console.log('请重新连接 Codex MCP 或重启 Codex。');}
  else {const panel=await openPanel();const browser=spawn('explorer.exe',[panel.url],{windowsHide:true,stdio:'ignore'});browser.on('error',e=>console.error('无法打开浏览器：'+e.message));}
}catch(error){console.error(error.message);process.exitCode=1;}
finally{await core.dispose();}
}
