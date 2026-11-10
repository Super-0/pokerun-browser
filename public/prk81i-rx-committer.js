'use strict';
// PRK81I-A: peer replies are committed to the real native host RX mailbox
// from a dedicated worker, without hidden-tab timers or WASM reentry.
// A reply must come over BroadcastChannel from the distinct peer tab.
var initialized=false,channel=null,ctrl=null,bytes=null,settings=null,delivered=0;
function send(kind,other){self.postMessage(Object.assign({kind:kind},other||{}));}
function fail(stage,error){send('error',{stage:stage,message:String(error&&(error.stack||error.message)||error)});}
self.onmessage=function(event){
 const m=event.data;
 if(!m||m.kind!=='init'||initialized)return;
 try{
  if(!self.crossOriginIsolated||!(m.heap instanceof SharedArrayBuffer))
   throw Error('Cross-origin isolated shared WASM heap required.');
  if(!Number.isInteger(m.rx)||m.rx<1024||m.rx%4!==0||
     m.rx+1056>m.heap.byteLength)throw Error('Invalid RX pointer.');
  if(!m.room||!m.from||!m.to)throw Error('Incomplete room identity.');
  ctrl=new Int32Array(m.heap,m.rx,8);
  bytes=new Uint8Array(m.heap,m.rx+32,1024);
  settings=m;
  channel=new BroadcastChannel('pokerun-prk81i-live-frames-v1-'+m.room);
  channel.onmessage=function(event){
   const reply=event.data;
   if(!reply||reply.kind!=='reply'||reply.room!==settings.room||
      reply.role!=='peer'||reply.from!==settings.to||
      reply.to!==settings.from)return;
   try{
    if(delivered>=4)throw Error('Unexpected extra native peer reply.');
    const sequence=delivered+1;
    const frame=reply.frame;
    const marker=[11,22,33,44][delivered];
    if(reply.sequence!==sequence||reply.marker!==marker||
       reply.timestamp!==1000||reply.aid!==1||
       !(frame instanceof Uint8Array)||frame.length!==36||
       frame[10]!==24||frame[11]!==0||
       frame[14]!==marker||frame[15]!==0xA7)
     throw Error('Peer native reply failed identity, order or frame checks.');
    const deadline=performance.now()+100;
    let state=Atomics.load(ctrl,0);
    while(state!==1){
     if(state!==0)throw Error('Unexpected native RX state '+state);
     if(performance.now()>deadline)
      throw Error('Native host was not waiting when peer response arrived.');
     Atomics.wait(ctrl,0,0,2);
     state=Atomics.load(ctrl,0);
    }
    bytes.fill(0);
    bytes.set(frame); // Exact peer-originated native callback payload.
    Atomics.store(ctrl,1,sequence===4?sequence+1:sequence); // stale negative case only.
    Atomics.store(ctrl,2,frame.length);
    Atomics.store(ctrl,3,1);
    Atomics.store(ctrl,0,2);
    Atomics.notify(ctrl,0,1); // Wake native emscripten_futex_wait.
    delivered++;
    send('delivered',{sequence,marker,mode:sequence===4?'stale':'valid'});
   }catch(e){fail('rx-delivery',e);}
  };
  initialized=true;
  send('ready');
 }catch(e){fail('rx-init',e);}
};
