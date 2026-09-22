import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('shift admin UI uses cyclic shifts without weekday controls',()=>{
 const html=fs.readFileSync('public/index.html','utf8'),js=fs.readFileSync('public/shift-admin.js','utf8');
 assert.match(html,/data-perm="manage_checklist_shifts" data-tab="checklist-shifts"/);
 assert.match(js,/\/checklist-shift-schedules/);
 assert.match(js,/based_on_version_id/);
 assert.match(js,/applicable_days/);
 assert.match(js,/local_start_time/);
 assert.match(js,/local_end_time/);
 assert.match(js,/timezone/);
 assert.match(js,/effective_from/);
 assert.match(js,/Dərc et/);
 assert.match(js,/Dövrün başlanğıcı/);assert.doesNotMatch(js,/data-day=/);
 assert.match(js,/label:'Növbə 1',applicable_days:\[\],local_start_time:'20:00',local_end_time:'08:00'/);
 assert.match(js,/label:'Növbə 2',applicable_days:\[\],local_start_time:'08:00',local_end_time:'20:00'/);
 assert.doesNotMatch(js,/fetch\([^)]*\/publish[^)]*\)/);
});
