import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore Browser module deliberately has no Node dependencies.
import {ChecklistAutosave} from '../public/checklist-autosave.js';
const tick=()=>new Promise(r=>setTimeout(r,0));
test('serial autosave keeps newer input while an older response is pending',async()=>{
 const pending:any[]=[],sent:any[]=[],states:string[]=[];
 const q=new ChecklistAutosave((key:string,body:any)=>{sent.push({key,body});return new Promise(resolve=>pending.push(resolve));},(q:any)=>states.push(q.status));
 q.register('a',1);q.register('b',1);q.edit('a',{comment:'old'},true);q.edit('a',{comment:'new'},true);q.edit('b',{result:'ok'},true);
 assert.equal(sent.length,1);pending.shift()({item:{revision:2}});await tick();assert.equal(sent[1].body.comment,'new');assert.equal(sent[1].body.expectedRevision,2);
 pending.shift()({item:{revision:3}});await tick();assert.equal(sent[2].key,'b');pending.shift()({item:{revision:2}});await tick();assert.equal(q.dirty,false);assert.equal(q.status,'saved');assert.equal(states.at(-1),'saved');q.dispose();
});
test('failed autosave stays failed, keeps values, and retries explicitly; conflict is not silently overwritten',async()=>{
 let fail=true;const bodies:any[]=[];const q=new ChecklistAutosave(async(_key:string,b:any)=>{bodies.push(b);if(fail)throw Object.assign(Error('conflict'),{status:409});return {item:{revision:2}};});
 q.register('a',1);q.edit('a',{comment:'keep me'},true);await tick();assert.equal(q.status,'error');assert.equal(q.dirty,true);q.edit('a',{comment:'still here'},true);await tick();assert.equal(bodies.length,1);assert.equal(q.status,'error');
 fail=false;await q.retry();assert.equal(bodies[1].comment,'still here');assert.equal(bodies[1].expectedRevision,1);assert.equal(q.status,'saved');q.dispose();
});
test('comments debounce, blur flush and disposal ignore stale responses',async()=>{
 let calls=0,resolve:any;const q=new ChecklistAutosave(()=>{calls++;return new Promise(r=>resolve=r);});q.register('a',1);
 q.edit('a',{comment:'1'});q.edit('a',{comment:'12'});assert.equal(calls,0);q.flush();assert.equal(calls,1);q.dispose();resolve({item:{revision:2}});await tick();assert.equal(q.entries.get('a').revision,1);
});

test('comment typing is debounced to one save',async()=>{
 const bodies:any[]=[];const q=new ChecklistAutosave(async(_k:string,b:any)=>{bodies.push(b);return {section:{revision:2}};});q.register('section',1);
 q.edit('section',{section_comment:'a'});q.edit('section',{section_comment:'ab'});q.edit('section',{section_comment:'abc'});
 assert.equal(bodies.length,0);await new Promise(r=>setTimeout(r,720));assert.equal(bodies.length,1);assert.equal(bodies[0].section_comment,'abc');assert.equal(q.status,'saved');q.dispose();
});
