'use strict';
// PRK81I: disposable, distinct-firmware Nintendo DS cores.
// Real game frames surround the PRK81H native callback test.
// No saved data, no uploaded ROM, no actual gameplay wireless reply.
const role=new URL(self.location.href).searchParams.get('role');
const identity=role==='host'?1:role==='peer'?2:0;
let mod,emu,cart,runtimeReady=false,booted=false,busy=false,finished=false;
let frames=0,callbacks=0,saveWrites=0;
function send(kind,props){self.postMessage(Object.assign({kind},props||{}));}
function fail(stage,e){send('error',{stage,message:String(e&&(e.stack||e.message))||e});}
function getFS(){
 const fs=self.FS||(mod&&mod.FS);
 if(!fs||typeof fs.writeFile!=='function')throw Error('WASM virtual filesystem unavailable');
 return fs;
}
function mkdir(fs,path){
 try{fs.mkdir(path);}
 catch(e){if(!fs.analyzePath||!fs.analyzePath(path).exists)throw e;}
}
self.WebMelon={_internal:{events:{
 onEmulatorFrameUpdate:function(){callbacks++;},
 onSaveWrite:function(){saveWrites++;},
 onRumbleStart:function(){},onRumbleStop:function(){},onShutdown:function(){}
}}};
var Module={
 locateFile:function(name){return '/emulators/melonds/'+name+'?v=prk81i';},
 onAbort:function(e){fail('wasm-abort',e);},
 onRuntimeInitialized:async function(){
  try{
   if(!identity)throw Error('Invalid host/peer worker role');
   mod=self.Module||Module;
   emu=new mod.WasmEmulator();
   const stamp=Number(await emu.pokerunRuntimeVersion());
   if(stamp!==0x50524b4b)throw Error('Expected stamp 0x50524b4b; got 0x'+stamp.toString(16));
   getFS();
   runtimeReady=true;
   send('runtime-ready',{role,stamp});
  }catch(e){fail('wasm-bootstrap',e);}
 }
};
self.Module=Module;
self.addEventListener('error',e=>fail('worker',e.error||e.message));
self.addEventListener('unhandledrejection',e=>fail('promise',e.reason));

async function runFrames(amount){
 const start=performance.now();
 for(let i=0;i<amount;i++){
  await emu.processFrame(false);
  frames++;
  if((i+1)%5===0)await new Promise(resolve=>setTimeout(resolve,0));
 }
 return performance.now()-start;
}
async function bootRom(buffer){
 if(!(buffer instanceof ArrayBuffer)||buffer.byteLength<1048576||buffer.byteLength>536870912)
  throw Error('Choose an uncompressed .nds ROM between 1 MB and 512 MB.');
 const fs=getFS();
 mkdir(fs,'/pokerun');mkdir(fs,'/pokerun/prk81i');
 fs.writeFile('/pokerun/prk81i/game.nds',new Uint8Array(buffer));
 send('stage',{stage:'ROM mounted in temporary memory',bytes:buffer.byteLength});
 cart=new mod.WasmNdsCart();
 if(!cart.loadFromFile('/pokerun/prk81i/game.nds'))throw Error('Failed to open NDS cartridge.');
 emu.setSavePath('/pokerun/prk81i/temporary.sav');
 const accepted=await emu.prk71SetFirmwareMacRole(identity);
 if(accepted!==true)throw Error('Could not set in-memory firmware identity.');
 emu.loadFreeBIOS();
 const applied=Number(await emu.prk71AppliedFirmwareMacRole());
 if(applied!==identity)throw Error('Applied firmware identity differs from role.');
 if(!emu.loadRom(cart,false))throw Error('Failed to attach cartridge.');
 emu.initialize(true);
 send('stage',{stage:'Real DS booted'});
 const elapsed=await runFrames(30);
 await emu.prk66SetEnabled(true);
 if(role==='host')await emu.prk81gEnable(true);
 booted=true;
 const info={role,frames,callbacks,saveWrites,elapsed,firmwareRole:applied,stamp:0x50524b4b};
 if(role==='host'){
  const tx=Number(await emu.prk81gTxPtr());
  const rx=Number(await emu.prk81gRxPtr());
  const view=self.HEAPU8||(mod&&mod.HEAPU8);
  if(!(view instanceof Uint8Array)||!(view.buffer instanceof SharedArrayBuffer))
   throw Error('Host shared WASM heap unavailable.');
  if(!Number.isSafeInteger(tx)||!Number.isSafeInteger(rx)||tx%4||rx%4||
     tx<1024||rx<1024||tx+2080>view.buffer.byteLength||rx+1056>view.buffer.byteLength)
   throw Error('Invalid host native mailbox pointers.');
  send('booted',Object.assign(info,{tx,rx,heap:view.buffer}));
 }else{
  if(typeof emu.prk81hPeerReplyFromQueue!=='function')
   throw Error('Native peer Platform callback missing');
  send('booted',info);
 }
}
async function hostTest(marker){
 if(!Number.isInteger(marker)||marker<1||marker>255)
  throw Error('Invalid marker.');
 send('calling',{marker});
 const start=performance.now();
 const result=Number(await emu.prk81gTestPlatformRoundTrip(marker));
 send('host-result',{marker,result,elapsed:performance.now()-start,stats:{
  matched:Number(await emu.prk81gMatched()),
  rejected:Number(await emu.prk81gRejected()),
  timedOut:Number(await emu.prk81gTimedOut()),
  dropped:Number(await emu.prk81gDropped())
 }});
}
async function peerTest(m){
 const frame=m.frame;
 if(!(frame instanceof Uint8Array)||frame.length!==36||
    !Number.isInteger(m.sequence)||m.sequence<1||m.timestamp!==1000)
  throw Error('Invalid peer command.');
 if(await emu.prk66InjectIncoming(frame,m.timestamp)!==true)
  throw Error('Native peer receive queue rejected command.');
 const result=Number(await emu.prk81hPeerReplyFromQueue());
 if(result!==36)throw Error('Native peer callback returned '+result);
 const outgoing=await emu.prk66TakeOutgoing();
 if(!outgoing||!(outgoing.bytes instanceof Uint8Array)||
    outgoing.bytes.length!==36||outgoing.replyAid!==1||
    outgoing.bytes[15]!==0xA7)
  throw Error('Peer native callback did not emit a test reply.');
 send('peer-reply',{marker:m.marker,sequence:m.sequence,
  frame:outgoing.bytes.slice(),timestamp:outgoing.timestamp,aid:outgoing.replyAid});
}
async function afterTest(){
 if(role==='host')await emu.prk81gEnable(false);
 await emu.prk66SetEnabled(false);
 const elapsed=await runFrames(30);
 finished=true;
 send('post-frames',{role,frames,callbacks,saveWrites,elapsed});
}
self.onmessage=async function(event){
 const m=event.data;
 if(!m||!runtimeReady||busy||finished)return;
 if(m.kind==='boot'&&!booted){
  busy=true;try{await bootRom(m.rom);}catch(e){fail('native-boot',e);}finally{busy=false;}
 }else if(m.kind==='host-test'&&booted&&role==='host'){
  busy=true;try{await hostTest(m.marker);}catch(e){fail('host-test',e);}finally{busy=false;}
 }else if(m.kind==='peer-command'&&booted&&role==='peer'){
  busy=true;try{await peerTest(m);}catch(e){fail('peer-test',e);}finally{busy=false;}
 }else if(m.kind==='post-frames'&&booted){
  busy=true;try{await afterTest();}catch(e){fail('post-frames',e);}finally{busy=false;}
 }
};
try{
 send('stage',{stage:'loading native runtime'});
 importScripts('/emulators/melonds/wasmemulator.js?v=prk81i');
 send('stage',{stage:'native script imported'});
}catch(e){fail('importScripts',e);}
