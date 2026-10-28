import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, operationLock } from './manager.js';
import {APP_ROOT} from './paths.js';

async function existing(){
  try{
    const session=JSON.parse(fs.readFileSync(path.join(ROOT,'data','panel-session.json'),'utf8'));
    const url=new URL(session.origin);if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')return null;
    const res=await fetch(session.origin+'/api/health',{headers:{authorization:'Bearer '+session.token},signal:AbortSignal.timeout(1000)});
    if(!res.ok)return null;
    if((await res.json()).instance!==session.instance)return null;
    return session;
  }catch{return null;}
}
export async function openPanel(){
  return operationLock('panel-launch',async()=>{
    let session=await existing();if(session)return {url:session.url,reused:true};
    const data=path.join(ROOT,'data');fs.mkdirSync(data,{recursive:true});
    const log=fs.openSync(path.join(data,'panel.log'),'a');
    const child=spawn(process.execPath,[path.join(APP_ROOT,'dist','panel.js')],{cwd:APP_ROOT,env:{...process.env,GITHUB_MANAGER_PANEL_CHILD:'1'},detached:true,windowsHide:true,stdio:['ignore',log,log]});
    fs.closeSync(log);
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
    for(let i=0;i<40;i++){await new Promise(resolve=>setTimeout(resolve,250));session=await existing();if(session)return {url:session.url,reused:false};}
    throw new Error('管理面板未能启动，请检查 data/panel.log');
  });
}
