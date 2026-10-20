/* Same-origin POS proxy to the authenticated Windows loopback companion. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawn}=require('node:child_process');
const home=()=>process.env.ORAFORGE_ETIMS_HOME || path.join(process.env.LOCALAPPDATA || process.env.HOME || '.', 'OraforgePOS','etims');
let starting=null;
const HELPER_BUILD='20261017.1';
function config(){try{return JSON.parse(fs.readFileSync(path.join(home(),'config.json'),'utf8').replace(/^\uFEFF/,''));}catch{return {};}}
function launchTarget(){
  const source=path.resolve(__dirname,'../windows/etims-helper/server.py');
  const frozen=file=>({command:file,args:[],entry:file,mode:'frozen'});
  const envExe=process.env.ORAFORGE_ETIMS_EXE;
  if(envExe && fs.existsSync(envExe))return frozen(envExe);
  // Developer override: run the Python source on purpose.
  if(process.env.ORAFORGE_ETIMS_PYTHON && fs.existsSync(source))
    return {command:process.env.ORAFORGE_ETIMS_PYTHON,args:[source],entry:source,mode:'source'};
  // Packaged app first, so a customer PC never needs Python.
  const candidates=[
    path.resolve(__dirname,'../../runtime/etims/OraforgeEtims/OraforgeEtims.exe'),
    config().helper_exe,
    path.resolve(__dirname,'../dist/windows/OraforgePOS/runtime/etims/OraforgeEtims/OraforgeEtims.exe')
  ];
  for(const exe of candidates){if(exe && fs.existsSync(exe))return frozen(exe);}
  return {command:'python.exe',args:[source],entry:source,mode:'source'};
}
function verifyHealth(health,target=launchTarget()){
  const samePath=value=>typeof value==='string' && path.resolve(value).toLowerCase()===path.resolve(target.entry).toLowerCase();
  if(health.app!=='oraforge-etims-helper' || health.version!==2 || health.build!==HELPER_BUILD ||
     health.runtime_mode!==target.mode || !samePath(health.runtime_entry) ||
     (target.mode==='frozen' && !samePath(health.runtime_executable))){
    const error=Error('The active eTIMS helper differs from the installed build. Restart the Windows helper, then recover this same sale.');
    error.code='ETIMS_HELPER_MISMATCH';error.health=health;throw error;
  }
  return health;
}
function call(route,method='GET',body,timeout=30000){
  return new Promise((resolve,reject)=>{
    let token='';if(route!=='/health')try{token=fs.readFileSync(path.join(home(),'helper.token'),'utf8').trim();}catch{return reject(Error('Windows eTIMS helper has not started.'));}
    const raw=body===undefined?null:Buffer.from(JSON.stringify(body));
    const req=http.request({hostname:'127.0.0.1',port:config().port || 17383,path:route,method,timeout,
      headers:{...(token?{Authorization:'Bearer '+token}:{}),...(raw?{'Content-Type':'application/json','Content-Length':raw.length}:{})}},res=>{
      let chunks=[],size=0;res.on('data',chunk=>{size+=chunk.length;if(size>2_000_000){req.destroy(Error('Companion response exceeds limit'));return;}chunks.push(chunk);});
      res.on('end',()=>{try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(res.statusCode>=400){const error=Error(result.error || 'Windows companion stopped');error.status=res.statusCode;reject(error);}else resolve(result);}catch(e){reject(e);}});
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(Error('Windows companion timed out. Recover the same sale before retrying.')));
    if(raw)req.write(raw);req.end();
  });
}
function killPort(){
  try{
    require('node:child_process').execSync('powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort '+(Number(config().port)||17383)+' -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"',{stdio:'ignore'});
  }catch(_){}
}
function note(text){try{fs.appendFileSync(path.join(home(),'helper-start.log'),'['+new Date().toISOString()+'] '+text+'\n');}catch(_){}}
function openStartLog(){
  try{fs.mkdirSync(home(),{recursive:true});return fs.openSync(path.join(home(),'helper-start.log'),'a');}catch{return 'ignore';}
}
async function ensure(){
  const target = launchTarget();
  try{return verifyHealth(await call('/health','GET',undefined,800), target);}catch(error){
    if(error.code==='ETIMS_HELPER_MISMATCH'){killPort();await new Promise(resolve=>setTimeout(resolve,300));}
    if(process.platform!=='win32')throw Error('Invoice issuance requires Oraforge on the Windows eTIMS computer.');
    if(starting)return starting;
    starting=(async()=>{
      const startup=config();
      const fastUi=startup.fast_ui!==false; // fast engine needs no administrator rights
      const log=openStartLog();
      const stdio=['ignore',log,log];
      const env={...process.env,ORAFORGE_ETIMS_HOME:home()};
      let child;
      if(target.mode==='source' || fastUi){
        // Run directly. Output goes to helper-start.log so a crash is never silent.
        child=spawn(target.command,target.args,{windowsHide:true,detached:true,stdio,env,cwd:path.dirname(target.entry)});
      }else{
        // Classic UI-automation mode: helper must run as administrator like the eTIMS client.
        let {command,args}=target;
        if(startup.startup_mode==='scheduled_highest' && startup.startup_task){command='schtasks.exe';args=['/Run','/TN',startup.startup_task];}
        const psArgs=['-NoProfile','-Command',`Start-Process -FilePath '${command.replace(/'/g,"''")}' -ArgumentList @(${args.map(a=>`'${a.replace(/'/g,"''")}'`).join(',')}) -Verb RunAs -WindowStyle Hidden`];
        child=spawn('powershell.exe',psArgs,{windowsHide:true,detached:true,stdio,env});
      }
      const direct=target.mode==='source' || fastUi;
      let failed=false,exited=null;
      note('starting '+target.mode+' helper: '+target.command);
      child.on('error',error=>{failed=true;note('could not start helper: '+error.message);});
      child.on('exit',(code,signal)=>{if(direct){exited={code,signal};note('helper exited, code='+code+' signal='+signal);}});
      child.unref();
      if(typeof log==='number'){try{fs.closeSync(log);}catch(_){}}
      let mismatch=null;
      for(let i=0;i<40;i++){
        await new Promise(resolve=>setTimeout(resolve,250));
        if(failed||exited)break;
        try{return verifyHealth(await call('/health','GET',undefined,600), target);}catch(e){
          if(e.code==='ETIMS_HELPER_MISMATCH'){mismatch=e;killPort();}
        }
      }
      if(mismatch){
        const h=mismatch.health||{};
        throw Error('An older eTIMS helper is still running ('+(h.runtime_mode||'?')+(h.elevated?', administrator':'')+': '+(h.runtime_entry||'unknown')+') and could not be stopped. Close it in Task Manager (run as administrator), then try again.');
      }
      if(exited)throw Error('The eTIMS helper stopped right after it started (exit code '+exited.code+'). Details: '+path.join(home(),'helper-start.log'));
      throw Error('The eTIMS helper did not start. Reason is in '+path.join(home(),'helper-start.log')+'.');
    })().finally(()=>{starting=null;});
    return starting;
  }
}
function local(req){
  const remote=req.socket.remoteAddress;
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote))return false;
  const host=req.headers.host || '';
  if(!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))return false;
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  if(req.headers.origin){try{const origin=new URL(req.headers.origin);if(origin.protocol!=='http:' || origin.host!==host)return false;}catch{return false;}}
  return true;
}
async function handle(req,res){
  const send=(code,value)=>{
    res.writeHead(code,{
      'Content-Type':'application/json',
      'Cache-Control':'no-store',
      'Access-Control-Allow-Origin':'*'
    });
    res.end(JSON.stringify(value));
  };

  if(req.method==='OPTIONS'){
    res.writeHead(204,{
      'Access-Control-Allow-Origin':'*',
      'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type, Authorization, X-Oraforge-Etims, X-Oraforge-Shop'
    });
    return res.end();
  }

  const parsedUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const route = parsedUrl.pathname.replace(/^\/api\/etims/, '') || '/';

  // Diagnostic tunnel endpoint
  if(route === '/status' || route === '/tunnel/status' || route === '/tunnel-status'){
    const tunnel = require('./etims-tunnel-server');
    return send(200, {
      app: 'oraforge-pos',
      platform: process.platform,
      tunnel_agents: tunnel.connectedAgentsList(),
      server_time: new Date().toISOString()
    });
  }

  if(!['/health','/preflight','/jobs'].includes(route) && !/^\/jobs\/[0-9a-f]{64}(\/recover|\/details|\/finish)?$/.test(route)){
    return send(404,{error:'Unknown eTIMS operation'});
  }

  try{
    let body;
    if(req.method==='POST'){
      if(req.headers['content-type']?.split(';')[0]!=='application/json' || req.headers['x-oraforge-etims']!=='2')return send(400,{error:'Structured POS request required'});
      let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>2_000_000)return send(413,{error:'Sale request too large'});chunks.push(chunk);}
      try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return send(400,{error:'Invalid JSON payload'});}
    }else if(req.method!=='GET'){
      return send(405,{error:'Unsupported method'});
    }

    const tunnel = require('./etims-tunnel-server');
    const shopId = req.headers['x-oraforge-shop'] || parsedUrl.searchParams.get('shop_id') || 'default';
    
    // Direct Windows local desktop mode: only when running directly on Windows desktop, accessed locally, and not in cloud mode
    const isCloudMode = process.platform !== 'win32' || process.env.POS_CLOUD_MODE === '1' || !local(req);
    const useDirectLocal = !isCloudMode && !tunnel.isAgentConnected(shopId);

    if(useDirectLocal){
      await ensure();
      const result=await call(route,req.method,body);
      return send(req.method==='POST' && route.includes('/jobs')?202:200,result);
    }

    // Cloud / Linux / WebSocket tunnel mode
    if(!tunnel.isAgentConnected(shopId)){
      return send(503,{
        error: `Local eTIMS helper is not connected for shop "${shopId}". Please run the Oraforge eTIMS companion on the cashier Windows computer.`,
        code: 'ETIMS_TUNNEL_NOT_CONNECTED',
        shop_id: shopId,
        connected: false
      });
    }

    const reply = await tunnel.forwardToAgent(shopId, route, req.method, body);
    if(reply && reply.error){
      return send(reply.status || 500, { error: reply.error });
    }
    const data = (reply && reply.data !== undefined) ? reply.data : reply;
    const status = (reply && reply.status) ? reply.status : (req.method==='POST' && route.includes('/jobs') ? 202 : 200);
    send(status, data);
  }catch(error){
    send(error.status || 503,{error:error.message});
  }
}
module.exports={handle,ensure,local,verifyHealth,HELPER_BUILD};
