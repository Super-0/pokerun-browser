'use strict';
// PRK81G test only: actual melonDS Platform::MP_SendCmd and MP_RecvReplies.
// The real Platform callback mode is opt-in; no ROM or game frame is loaded.
var emu=null, started=false, busy=false;
function send(kind,data){self.postMessage(Object.assign({kind:kind},data||{}))}
function failure(stage,e){send('error',{stage:stage,message:String(e&&(e.stack||e.message)||e)})}
var Module={
  locateFile:function(name){return '/emulators/melonds/'+name+'?v=prk81g'},
  onAbort:function(e){failure('wasm-abort',e)},
  onRuntimeInitialized:async function(){
    try{
      var module=self.Module||Module;
      emu=new module.WasmEmulator();
      var stamp=Number(await emu.pokerunRuntimeVersion());
      if(stamp!==0x50524b4b)throw Error('Expected runtime 0x50524b4b, got '+stamp.toString(16));
      await emu.prk66SetEnabled(true);
      await emu.prk81gEnable(true);
      var txPtr=Number(await emu.prk81gTxPtr());
      var rxPtr=Number(await emu.prk81gRxPtr());
      var heap=self.HEAPU8||module.HEAPU8;
      if(!(heap instanceof Uint8Array)||!(heap.buffer instanceof SharedArrayBuffer))
        throw Error('Expected shared WASM heap.');
      if(!Number.isSafeInteger(txPtr)||!Number.isSafeInteger(rxPtr)||
         txPtr%4!==0||rxPtr%4!==0||txPtr<1024||rxPtr<1024||
         txPtr+2080>heap.buffer.byteLength||rxPtr+1056>heap.buffer.byteLength)
        throw Error('Invalid native TX/RX mailbox pointers.');
      started=true;
      send('ready',{stamp:stamp,txPtr:txPtr,rxPtr:rxPtr,heap:heap.buffer});
    }catch(e){failure('native-startup',e)}
  }
};
self.Module=Module;
self.addEventListener('error',function(e){failure('worker-error',e.error||e.message)});
self.addEventListener('unhandledrejection',function(e){failure('unhandled-promise',e.reason)});
self.onmessage=async function(event){
  var message=event.data;
  if(!message||message.kind!=='run'||!started||busy)return;
  busy=true;
  try{
    var marker=message.marker;
    if(!Number.isInteger(marker)||marker<1||marker>255)throw Error('Invalid test marker');
    send('calling',{marker:marker});
    var startedAt=performance.now();
    var result=Number(await emu.prk81gTestPlatformRoundTrip(marker));
    var stats={
      matched:Number(await emu.prk81gMatched()),
      rejected:Number(await emu.prk81gRejected()),
      timedOut:Number(await emu.prk81gTimedOut()),
      dropped:Number(await emu.prk81gDropped())
    };
    send('result',{marker:marker,result:result,ms:performance.now()-startedAt,stats:stats});
  }catch(e){failure('callback-round-trip',e)}
  finally{busy=false}
};
try{send('stage',{stage:'loading-WASM'});importScripts('/emulators/melonds/wasmemulator.js?v=prk81g');send('stage',{stage:'WASM-script-imported'})}
catch(e){failure('script-import',e)}
