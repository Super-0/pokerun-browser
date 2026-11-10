'use strict';
// PRK81I-A: Native TX observer is a separate, lightweight transport worker.
// It reads the *existing* 1GB shared WASM memory (no copy), not a second ROM.
// Atomics.wait with a finite timeout avoids hidden-tab setTimeout throttling.
// Native PRK81G publishes state=1 but does not notify; timed waits are required.
var initialized=false,active=false,channel=null,ctrl=null,bytes=null,settings=null;
function send(kind,other){self.postMessage(Object.assign({kind:kind},other||{}));}
function fail(stage,error){send('error',{stage:stage,message:String(error&&(error.stack||error.message)||error)});}
self.onmessage=function(event){
 const m=event.data;
 if(!m)return;
 if(m.kind==='init'&&!initialized){
  try{
   if(!self.crossOriginIsolated||!(m.heap instanceof SharedArrayBuffer))
    throw Error('Shared WASM memory and cross-origin isolation required.');
   if(!Number.isInteger(m.tx)||m.tx<1024||m.tx%4!==0||
      m.tx+2080>m.heap.byteLength)throw Error('Invalid TX pointer');
   if(!Array.isArray(m.cases)||m.cases.length!==5)
    throw Error('Exactly five bounded callback cases required.');
   if(!m.room||!m.from||!m.to)throw Error('Incomplete transport identity.');
   ctrl=new Int32Array(m.heap,m.tx,8);
   bytes=new Uint8Array(m.heap,m.tx+32,2048);
   if(Atomics.load(ctrl,0)!==0)throw Error('TX mailbox not idle before test.');
   settings=m;
   channel=new BroadcastChannel('pokerun-prk81i-live-frames-v1-'+m.room);
   initialized=true;
   send('ready');
  }catch(e){fail('tx-init',e);}
 }else if(m.kind==='start'&&initialized&&!active){
  active=true;
  send('armed');
  try{
   for(let index=0;index<settings.cases.length;index++){
    const test=settings.cases[index],deadline=performance.now()+5000;
    let state=Atomics.load(ctrl,0);
    while(state!==1){
     if(state!==0&&state!==3)throw Error('Invalid TX state '+state);
     if(performance.now()>deadline)throw Error('Native TX publish timeout for case '+(index+1));
     Atomics.wait(ctrl,0,state,2); // native producer currently does not notify.
     state=Atomics.load(ctrl,0);
    }
    const sequence=Atomics.load(ctrl,1);
    const length=Atomics.load(ctrl,2);
    const low=Atomics.load(ctrl,3);
    const high=Atomics.load(ctrl,4);
    if(sequence!==index+1||length!==36||low!==1000||high!==0||
       bytes[10]!==24||bytes[11]!==0||bytes[14]!==test.marker)
      throw Error('Malformed native command seq='+sequence+' len='+length);
    const frame=bytes.slice(0,length);
    Atomics.store(ctrl,0,0);
    // Dedicated worker forwards directly; no browser-window timer is involved.
    channel.postMessage({
     kind:'command',room:settings.room,role:'host',
     from:settings.from,to:settings.to,sequence,
     marker:test.marker,mode:test.mode,frame,timestamp:1000
    });
    send('forwarded',{sequence,marker:test.marker,mode:test.mode});
   }
   send('complete',{count:settings.cases.length});
  }catch(e){fail('tx-observe',e);}
  finally{if(channel)channel.close();}
 }
};
