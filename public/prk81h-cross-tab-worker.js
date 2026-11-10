'use strict';
// PRK81H: two independent worker-owned WASM instances. No ROM or save.
// Host uses PRK81G shared CMD/RX slots; peer uses the real native callbacks
// MP_RecvHostPacket and MP_SendReply on controlled test packet data.
const role=new URL(self.location.href).searchParams.get('role');
var emu=null,ready=false,busy=false;
function send(kind,detail){self.postMessage(Object.assign({kind:kind},detail||{}))}
function error(stage,e){send('error',{stage:stage,message:String((e&&(e.stack||e.message))||e)})}
var Module={
 locateFile:function(name){return '/emulators/melonds/'+name+'?v=prk81h'},
 onAbort:function(e){error('native-abort',e)},
 onRuntimeInitialized:async function(){
  try{
   if(role!=='host'&&role!=='peer')throw Error('Expected host or peer role.');
   var module=self.Module||Module;
   emu=new module.WasmEmulator();
   var stamp=Number(await emu.pokerunRuntimeVersion());
   if(stamp!==0x50524b4b)throw Error('Stale WASM stamp: '+stamp.toString(16));
   await emu.prk66SetEnabled(true);
   if(role==='host'){
    await emu.prk81gEnable(true);
    var tx=Number(await emu.prk81gTxPtr());
    var rx=Number(await emu.prk81gRxPtr());
    var heap=self.HEAPU8||module.HEAPU8;
    if(!(heap instanceof Uint8Array)||!(heap.buffer instanceof SharedArrayBuffer))
      throw Error('Expected shared native WASM memory.');
    if(!Number.isSafeInteger(tx)||!Number.isSafeInteger(rx)||
       tx%4!==0||rx%4!==0||tx<1024||rx<1024||
       tx+2080>heap.buffer.byteLength||rx+1056>heap.buffer.byteLength)
      throw Error('Invalid shared command/reply pointers.');
    ready=true;
    send('ready',{stamp:stamp,role:role,tx:tx,rx:rx,heap:heap.buffer});
   }else{
    if(typeof emu.prk81hPeerReplyFromQueue!=='function')
      throw Error('Native peer reply callback export unavailable.');
    ready=true;
    send('ready',{stamp:stamp,role:role});
   }
  }catch(e){error('native-initialization',e)}
 }
};
self.Module=Module;
self.addEventListener('error',e=>error('worker-error',e.error||e.message));
self.addEventListener('unhandledrejection',e=>error('promise-rejection',e.reason));
self.onmessage=async function(event){
 const m=event.data;
 if(!ready||busy||!m)return;
 if(role==='host'&&m.kind==='host-test'){
  busy=true;
  try{
   if(!Number.isInteger(m.marker)||m.marker<1||m.marker>255)
    throw Error('Invalid test marker.');
   send('calling',{marker:m.marker});
   const before=performance.now();
   const result=Number(await emu.prk81gTestPlatformRoundTrip(m.marker));
   const stats={
    matched:Number(await emu.prk81gMatched()),
    rejected:Number(await emu.prk81gRejected()),
    timedOut:Number(await emu.prk81gTimedOut()),
    dropped:Number(await emu.prk81gDropped())
   };
   send('host-result',{marker:m.marker,result:result,elapsed:performance.now()-before,stats:stats});
  }catch(e){error('host-test',e)}
  finally{busy=false}
 }else if(role==='peer'&&m.kind==='peer-command'){
  busy=true;
  try{
   const frame=m.frame;
   if(!(frame instanceof Uint8Array)||frame.length!==36||
      !Number.isSafeInteger(m.timestamp)||m.timestamp<0||
      !Number.isInteger(m.sequence)||m.sequence<1)
     throw Error('Invalid command delivered to peer worker.');
   const accepted=await emu.prk66InjectIncoming(frame,m.timestamp);
   if(accepted!==true)throw Error('Native incoming radio queue rejected the packet.');
   const returned=Number(await emu.prk81hPeerReplyFromQueue());
   if(returned!==frame.length)throw Error('Native MP_RecvHostPacket/MP_SendReply returned '+returned);
   const outgoing=await emu.prk66TakeOutgoing();
   if(!outgoing||!(outgoing.bytes instanceof Uint8Array)||
      outgoing.bytes.length!==frame.length||outgoing.replyAid!==1||
      outgoing.bytes[15]!==0xA7)
     throw Error('Native peer did not emit a distinguishable reply frame.');
   send('peer-reply',{
    sequence:m.sequence,marker:m.marker,
    frame:outgoing.bytes.slice(),
    timestamp:outgoing.timestamp,
    aid:outgoing.replyAid
   });
  }catch(e){error('peer-native-callbacks',e)}
  finally{busy=false}
 }
};
try{
 send('stage',{stage:'loading-native-worker'});
 importScripts('/emulators/melonds/wasmemulator.js?v=prk81h');
 send('stage',{stage:'native-script-imported'});
}catch(e){error('wasm-import',e)}
