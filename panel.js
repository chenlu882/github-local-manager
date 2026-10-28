import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import * as manager from './manager.js';
import {APP_ROOT,ROOT} from './paths.js';

const root=ROOT;
const assets=new Map([['/',['index.html','text/html; charset=utf-8']],['/setup.css',['setup.css','text/css; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);
const item=z.object({type:z.enum(['tool','git']),id:z.string().min(1).max(4096)}).strict();
const list=z.object({category:z.enum(['all','dsh','tool','codex','git','download']).default('all'),query:z.string().max(200).default(''),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(50),refresh:z.boolean().default(false)}).strict();
const apply=z.object({planId:z.string().uuid(),confirmationText:z.string().min(1).max(500)}).strict();

export async function createPanelServer({api=manager,writeSession=true}={}) {
  const token=randomBytes(32).toString('hex'),instance=randomUUID();
  let origin;
  const send=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    if(req.headers.host!==new URL(origin).host)return send(res,403,{error:'访问地址不匹配'});
    if(req.headers.origin && req.headers.origin!==origin)return send(res,403,{error:'拒绝其他网站的请求'});
    let url;try{url=new URL(req.url,origin);}catch{return send(res,400,{error:'地址无效'});}
    if(assets.has(url.pathname)&&req.method==='GET'){
      const [file,type]=assets.get(url.pathname);res.writeHead(200,{'content-type':type});res.end(fs.readFileSync(path.join(APP_ROOT,'web',file)));return;
    }
    if(!url.pathname.startsWith('/api/'))return send(res,404,{error:'没有这个地址'});
    const candidate=Buffer.from(String(req.headers.authorization||''));const expected=Buffer.from('Bearer '+token);
    if(candidate.length!==expected.length||!timingSafeEqual(candidate,expected))return send(res,401,{error:'访问凭据失效，请从聊天重新打开面板'});
    if(url.pathname==='/api/health'&&req.method==='GET')return send(res,200,{instance,version:'0.3.0'});
    if(req.method!=='POST')return send(res,405,{error:'请求方式无效'});
    if(req.headers.origin!==origin)return send(res,403,{error:'缺少可信来源'});
    if(String(req.headers['content-type']).split(';')[0]!=='application/json')return send(res,415,{error:'需要 JSON 请求'});
    try{
      let raw='',size=0;
      for await(const chunk of req){size+=chunk.length;if(size>65536){send(res,413,{error:'请求过大'});return;}raw+=chunk;}
      let body;try{body=JSON.parse(raw);}catch{return send(res,400,{error:'请求内容不是有效 JSON'});}
      let value;
      switch(url.pathname){
        case '/api/setup':value=api.getSetup();break;
        case '/api/setup/save':value=api.saveSetup(body);break;
        case '/api/list':value=await api.inventory(list.parse(body));break;
        case '/api/check':{const p=item.parse(body);value=await api.checkUpdate(p.type,p.id);break;}
        case '/api/prepare':{const p=item.parse(body);value=await api.prepareUpdate(p.type,p.id);break;}
        case '/api/apply':{const p=apply.parse(body);value=await api.applyUpdate(p.planId,p.confirmationText);break;}
        default:return send(res,404,{error:'没有这个操作'});
      }
      send(res,200,{ok:true,value});
    }catch(error){send(res,400,{ok:false,error:error instanceof z.ZodError?'请求参数无效':error.message});}
  });
  server.headersTimeout=15000;server.requestTimeout=450000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  origin='http://127.0.0.1:'+server.address().port;
  const session={pid:process.pid,origin,token,instance,url:origin+'/#'+token,startedAt:new Date().toISOString()};
  if(writeSession){fs.mkdirSync(path.join(root,'data'),{recursive:true});fs.writeFileSync(path.join(root,'data','panel-session.json'),JSON.stringify(session),{mode:0o600});}
  return {server,session,close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}

if(process.env.GITHUB_MANAGER_PANEL_CHILD==='1'){
  const running=await createPanelServer();
  // Session URL contains a secret; only store it in local runtime data.
  process.stderr.write('GitHub 本地管理面板已启动。\n');
  const stop=async()=>{await running.close();await manager.core.dispose();process.exit(0);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
}


