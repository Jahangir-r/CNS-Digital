import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {migrateChecklistDatabase} from '../src/checklists/migrations.js';
import {createShiftService} from '../src/checklists/shifts.js';
import {productionShiftDraft,currentProductionBoundary} from '../src/checklists/production-shift.js';

test('production schedule is a four-shift continuous cycle without weekdays',()=>{
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');migrateChecklistDatabase(db);
 try{
  const boundary='2026-09-20T16:00:00.000Z',service=createShiftService(db,()=>new Date(boundary));
  const schedule=service.create(productionShiftDraft(boundary),1);
  assert.equal(schedule.status,'draft');assert.equal(schedule.timezone,'Asia/Baku');assert.deepEqual(schedule.rules.map(r=>r.label),['Növbə 1','Növbə 2','Növbə 3','Növbə 4']);assert.ok(schedule.rules.every(r=>r.applicable_days.length===0));
  assert.equal(service.publish(schedule.id,schedule.revision,1).status,'published');
  assert.equal(currentProductionBoundary(new Date('2026-09-20T02:00:00Z')),'2026-09-19T16:00:00.000Z');
 }finally{db.close();}
});
