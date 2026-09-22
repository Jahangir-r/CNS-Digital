// One serial stream per open position. Pending values never get replaced by an older acknowledgement.
export class ChecklistAutosave {
  constructor(send, changed=()=>{}, saved=()=>{}) {this.send=send;this.changed=changed;this.saved=saved;this.entries=new Map();this.running=false;this.disposed=false;this.timer=null;}
  register(key,revision){this.entries.set(key,{revision,values:{},generation:0,ack:0,error:null});}
  get dirty(){return [...this.entries.values()].some(e=>e.generation!==e.ack);}
  get error(){return [...this.entries.values()].find(e=>e.error)?.error??null;}
  get status(){return this.error?'error':this.dirty||this.running?'saving':'saved';}
  edit(key,values,immediate=false){if(this.disposed)return;const e=this.entries.get(key);Object.assign(e.values,values);e.generation++;this.changed(this);clearTimeout(this.timer);if(immediate)this.flush();else this.timer=setTimeout(()=>this.flush(),650);}
  async flush(){clearTimeout(this.timer);if(this.running||this.disposed||this.error)return;this.running=true;
    try {while(!this.disposed){const pair=[...this.entries].find(([,e])=>e.generation!==e.ack);if(!pair)break;const [key,e]=pair,generation=e.generation;
      try {const response=await this.send(key,{...e.values,expectedRevision:e.revision});if(this.disposed)return;e.revision=response.item?.revision??response.section?.revision;e.ack=generation;this.saved(response);}
      catch(error){if(!this.disposed)e.error=error;break;}
    }}finally{this.running=false;if(!this.disposed)this.changed(this);}
  }
  retry(){for(const e of this.entries.values())e.error=null;this.changed(this);return this.flush();}
  dispose(){this.disposed=true;clearTimeout(this.timer);}
}
