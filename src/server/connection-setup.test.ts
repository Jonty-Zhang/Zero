import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConfigStore } from './config-store.js';
import { ConnectionSetupService } from './connection-setup.js';

async function fixture(run: (config: ConfigStore, path: string) => Promise<void>) {
  const parent=resolve('data/verification/boss-workflow-round21/jobs-tests'); await mkdir(parent,{recursive:true});
  const root=await mkdtemp(join(parent,'job-')); assert.ok(root.startsWith(parent+sep));
  await writeFile(join(root,'config.json'),JSON.stringify({models:[],bindings:[]}));
  try {await run(new ConfigStore(join(root,'config.json')),join(root,'connections.sqlite'));}
  finally {assert.ok(root.startsWith(parent+sep)); await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
const codex={async probe(){return {harness:'codex' as const,available:true,models:[],reasoningEfforts:['high','low']};}};
const payload={modelId:'gpt-6.1-sol',reasoningEffort:'high'};
const key='connection-request-123456';
test('setup never runs a model and reports an empty registry without hiding CLI availability',async()=>fixture(async(config,path)=>{
  let calls=0;const service=new ConnectionSetupService({config,path,codex,verify:async()=>{calls++;}});
  try {assert.deepEqual(await service.setup(),{codex:{available:true,models:[],reasoningEfforts:['high','low']}});assert.equal(calls,0);} finally {await service.close();}
}));
test('same key retries and other-tab keys share one durable active verification, preserving identity binding',async()=>fixture(async(config,path)=>{
  let calls=0;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const service=new ConnectionSetupService({config,path,codex,verify:async model=>{calls++;assert.equal(model.provider,'openai');await gate;}});
  try {
    const first=await service.submit(payload,key); const replay=await service.submit(payload,key);
    const other=await service.submit(payload,'another-tab-key-12345');assert.equal(replay.id,first.id);assert.equal(other.id,first.id);
    await assert.rejects(service.submit({...payload,reasoningEffort:'low'},key),/标识|请求|冲突/);
    await new Promise<void>(r=>setImmediate(r));assert.equal(calls,1);
    release();await service.close();
    const reopened=new ConnectionSetupService({config,path,codex,verify:async()=>{calls++;}});
    try {assert.equal(reopened.get(first.id)?.state,'succeeded');assert.equal((await reopened.submit(payload,key)).id,first.id);assert.equal(calls,1);}finally{await reopened.close();}
  }finally{release();await service.close();}
}));
for(const raw of [{...payload,modelId:'--model=evil'},{...payload,modelId:'bad name'},{...payload,modelId:'bad\nname'},{...payload,reasoningEffort:'ultra'},{...payload,extra:true}])test(`invalid verification input has no calls: ${JSON.stringify(raw)}`,async()=>fixture(async(config,path)=>{
  let calls=0;const service=new ConnectionSetupService({config,path,codex,verify:async()=>{calls++;}});
  try {await assert.rejects(service.submit(raw,key));assert.equal(calls,0);assert.equal((await config.read()).models.length,0);}finally{await service.close();}
}));
test('failed verification stores a bounded public error and does not expose raw provider output',async()=>fixture(async(config,path)=>{
  const service=new ConnectionSetupService({config,path,codex,verify:async()=>{throw new Error('SECRET-provider-token C:/private/auth.json');}});
  const job=await service.submit(payload,key);await service.close();
  const reopened=new ConnectionSetupService({config,path,codex,verify:async()=>{throw new Error('must not retry');}});
  try {const read=reopened.get(job.id)!;assert.equal(read.state,'failed');assert.ok(read.error);assert.ok(!read.error.includes('SECRET'));assert.equal((await config.read()).bindings.length,0);}finally{await reopened.close();}
}));
test('another live service never steals active jobs; dead-owner recovery is interruption without an automatic call',async()=>fixture(async(config,path)=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});let calls=0;
  const first=new ConnectionSetupService({config,path,codex,verify:async()=>{calls++;await gate;}});
  const job=await first.submit(payload,key);await new Promise<void>(r=>setImmediate(r));
  const second=new ConnectionSetupService({config,path,codex,ownerAlive:()=>true,verify:async()=>{calls++;}});
  try {second.recoverInterrupted();assert.equal(second.get(job.id)?.state,'running');assert.equal((await second.submit(payload,'second-service-key-123')).id,job.id);assert.equal(calls,1);}finally{await second.close();release();await first.close();}
  const sql=new DatabaseSync(path);try{sql.prepare("UPDATE connection_verifications SET state='running',owner_pid=999999 WHERE id=?").run(job.id);}finally{sql.close();}
  const third=new ConnectionSetupService({config,path,codex,ownerAlive:()=>false,verify:async()=>{calls++;}});
  try {third.recoverInterrupted();const read=third.get(job.id)!;assert.equal(read.state,'interrupted');assert.match(read.error!,/未确认/);assert.equal(calls,1);assert.equal((await third.submit(payload,key)).state,'interrupted');assert.equal(calls,1);}finally{await third.close();}
}));

test('paid verification finalization failures retain the original call and recover by writing SQL only',async()=>fixture(async(config,path)=>{
  let calls=0;
  const service=new ConnectionSetupService({config,path,codex,verify:async()=>{calls++;}});
  const sql=new DatabaseSync(path);
  try {
    sql.exec("CREATE TRIGGER reject_verification_finish BEFORE UPDATE OF state ON connection_verifications WHEN NEW.state IN ('succeeded','failed') BEGIN SELECT RAISE(ABORT,'injected finalization storage failure'); END;");
    const job=await service.submit(payload,key);
    const deadline=Date.now()+5000;
    while(service.get(job.id)?.state!=='interrupted' && Date.now()<deadline)await new Promise<void>(r=>setTimeout(r,10));
    assert.equal(service.get(job.id)?.state,'interrupted');
    assert.match(service.get(job.id)?.error??'',/结果记录未确认/);
    assert.equal(calls,1);
    assert.equal((await service.submit(payload,'new-key-after-storage-failure')).id,job.id);
    assert.equal(calls,1);
    assert.equal((sql.prepare('SELECT state FROM connection_verifications WHERE id=?').get(job.id) as {state:string}).state,'running');
    sql.exec('DROP TRIGGER reject_verification_finish');
    assert.equal(service.get(job.id)?.state,'succeeded');
    assert.equal(calls,1);
  }finally{sql.close();await service.close();}
}));

test('queued to running storage failures finish as an explicit failure without calling the model',async()=>fixture(async(config,path)=>{
  let calls=0;
  const service=new ConnectionSetupService({config,path,codex,verify:async()=>{calls++;}});
  const sql=new DatabaseSync(path);
  try {
    sql.exec("CREATE TRIGGER reject_verification_start BEFORE UPDATE OF state ON connection_verifications WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT,'injected start storage failure'); END;");
    const job=await service.submit(payload,key);
    const deadline=Date.now()+1000;
    while(service.get(job.id)?.state==='queued' && Date.now()<deadline)await new Promise<void>(r=>setTimeout(r,10));
    assert.equal(service.get(job.id)?.state,'failed');
    assert.match(service.get(job.id)?.error??'',/尚未发起|未调用/);
    assert.equal(calls,0);
    assert.equal((await service.submit(payload,key)).id,job.id);
    assert.equal(calls,0);
  }finally{sql.close();await service.close();}
}));

test('unrecorded startup failure reports no model call and later recovers its original failed result',async()=>fixture(async(config,path)=>{
  let calls=0;
  const service=new ConnectionSetupService({config,path,codex,verify:async()=>{calls++;}});
  const sql=new DatabaseSync(path);
  try {
    sql.exec("CREATE TRIGGER reject_all_job_updates BEFORE UPDATE OF state ON connection_verifications BEGIN SELECT RAISE(ABORT,'injected storage failure'); END;");
    const job=await service.submit(payload,key);
    const deadline=Date.now()+2000;
    while(service.get(job.id)?.state!=='interrupted' && Date.now()<deadline)await new Promise<void>(r=>setTimeout(r,10));
    assert.equal(service.get(job.id)?.state,'interrupted');
    assert.match(service.get(job.id)?.error??'',/尚未发起.*记录未确认/);
    assert.equal((await service.submit(payload,'new-key-after-start-storage-failure')).id,job.id);
    assert.equal(calls,0);
    sql.exec('DROP TRIGGER reject_all_job_updates');
    assert.equal(service.get(job.id)?.state,'failed');
    assert.match(service.get(job.id)?.error??'',/未调用模型/);
    assert.equal(calls,0);
  }finally{sql.close();await service.close();}
}));
