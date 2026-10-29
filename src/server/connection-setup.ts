import type { ModelConfig } from '../adapters/types.js';
import type { ConfigStore } from './config-store.js';
import type { HarnessAdapter } from '../domain/types.js';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { validateSubmissionKey } from '../core/submission-idempotency.js';

export interface VerificationJob { id: string; state: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'; modelId: string; requestedModelIds?: string[]; reasoningEffort: string; createdAt: string; finishedAt?: string; error?: string }
export interface ConnectionSetupOptions { path: string; config: ConfigStore; codex: Pick<HarnessAdapter, 'probe'>; verify: (model: ModelConfig, effort: string) => Promise<void>; ownerAlive?: (pid: number) => boolean }
export class ConnectionSetupError extends Error { constructor(readonly status: number, message: string) { super(message); } }
interface VerificationOutcome { state: 'succeeded' | 'failed'; finishedAt: string; error?: string; modelNotStarted?: true }
export class ConnectionSetupService {
  private readonly db: DatabaseSync;
  private readonly pending = new Set<Promise<void>>();
  private readonly unrecorded = new Map<string, VerificationOutcome>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly options: ConnectionSetupOptions) {
    this.db = new DatabaseSync(options.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS connection_verifications(id TEXT PRIMARY KEY,identity TEXT NOT NULL,model TEXT NOT NULL,model_id TEXT NOT NULL,effort TEXT NOT NULL,state TEXT NOT NULL,owner_pid INTEGER NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,error TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS connection_active_identity ON connection_verifications(identity) WHERE state IN ('queued','running');
      CREATE TABLE IF NOT EXISTS connection_verification_requests(key TEXT PRIMARY KEY,payload TEXT NOT NULL,job_id TEXT NOT NULL REFERENCES connection_verifications(id));`);
  }
  async setup() {
    const config = await this.options.config.read().catch(()=>{throw new ConnectionSetupError(503,'无法读取连接设置，请检查本地配置。');});
    const caps = await this.options.codex.probe().catch(()=>({available:false,reasoningEfforts:[] as string[]}));
    return { codex: { available: caps.available, ...(!caps.available ? { reason: 'Codex 运行入口不可用，请检查本机安装。' } : {}),
      models: config.models.filter(model => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model.id)).map(model => ({ id: model.id, label: model.modelId })),
      reasoningEfforts: (caps.reasoningEfforts??[]).filter(effort => ['minimal','low','medium','high','xhigh'].includes(effort)) } };
  }
  async submit(raw: unknown, rawKey: unknown): Promise<VerificationJob> {
    if (this.closed) throw new ConnectionSetupError(503,'服务正在关闭，请稍后查询原验证结果。');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConnectionSetupError(400,'验证请求格式无效');
    const input=raw as Record<string,unknown>;
    if (Object.keys(input).some(key => !['modelId','reasoningEffort'].includes(key)) || typeof input.modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(input.modelId)
        || typeof input.reasoningEffort !== 'string' || !['minimal','low','medium','high','xhigh'].includes(input.reasoningEffort)) throw new ConnectionSetupError(400,'模型或思考强度无效');
    let key: string;
    try {key=validateSubmissionKey(rawKey);} catch {throw new ConnectionSetupError(400,'验证请求必须携带有效请求标识');}
    const payload=JSON.stringify([input.modelId,input.reasoningEffort]);
    const replay=()=>{
      const prior=this.db.prepare('SELECT payload,job_id FROM connection_verification_requests WHERE key=?').get(key) as {payload:string;job_id:string}|undefined;
      if (prior && prior.payload!==payload) throw new ConnectionSetupError(409,'请求标识已用于另一项验证，不能更换内容');
      return prior ? this.get(prior.job_id) : undefined;
    };
    const previous=replay();if(previous)return previous;
    let model: ModelConfig;
    try {model=await this.options.config.registerCodexModel(input.modelId);} catch {throw new ConnectionSetupError(409,'模型身份不唯一或配置已变化，请检查模型标识');}
    if(this.closed)throw new ConnectionSetupError(503,'服务正在关闭，请稍后重试。');
    const identity=JSON.stringify([model.provider,model.modelId,input.reasoningEffort]);
    let job!:VerificationJob;let created=false;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const raced=replay();
      if(raced) {job=raced;} else {
        const active=this.db.prepare("SELECT id FROM connection_verifications WHERE identity=? AND state IN ('queued','running')").get(identity) as {id:string}|undefined;
        if(active) job=this.get(active.id)!;
        else {
          job={id:randomUUID(),state:'queued',modelId:model.id,reasoningEffort:input.reasoningEffort,createdAt:new Date().toISOString()};
          this.db.prepare("INSERT INTO connection_verifications(id,identity,model,model_id,effort,state,owner_pid,created_at) VALUES(?,?,?,?,?,'queued',?,?)").run(job.id,identity,JSON.stringify(model),model.id,input.reasoningEffort,process.pid,job.createdAt);created=true;
        }
        this.db.prepare('INSERT INTO connection_verification_requests(key,payload,job_id) VALUES(?,?,?)').run(key,payload,job.id);
      }
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
    if(created) {
      const run=this.execute(job,model);this.pending.add(run);void run.then(()=>this.pending.delete(run),()=>this.pending.delete(run));
    }
    return this.get(job.id)!;
  }
  get(id: string): VerificationJob | undefined {
    const unrecorded=this.unrecorded.get(id);
    if(unrecorded) {try{this.persistOutcome(id,unrecorded);this.unrecorded.delete(id);}catch{/* Keep paid-call custody even if result storage remains unavailable. */}}
    const row=this.db.prepare('SELECT * FROM connection_verifications WHERE id=?').get(id) as Record<string,unknown>|undefined;
    const requests=row ? this.db.prepare('SELECT payload FROM connection_verification_requests WHERE job_id=?').all(id) as Array<{payload:string}> : [];
    const requestedModelIds=[...new Set(requests.map(request=>(JSON.parse(request.payload) as string[])[0]!))];
    return row ? {id:String(row.id),state:row.state as VerificationJob['state'],modelId:String(row.model_id),requestedModelIds,reasoningEffort:String(row.effort),createdAt:String(row.created_at),...(row.finished_at?{finishedAt:String(row.finished_at)}:{}),...(row.error?{error:String(row.error)}:{}),...(this.unrecorded.has(id)?{state:'interrupted' as const,error:unrecorded?.modelNotStarted?'模型验证尚未发起，状态记录未确认。请刷新原结果；不会自动调用模型。':'验证调用已结束，但结果记录未确认。请刷新原结果；不会自动重复调用模型。'}:{})}:undefined;
  }
  recoverInterrupted(): void {
    const rows=this.db.prepare("SELECT id,owner_pid FROM connection_verifications WHERE state IN ('queued','running')").all() as Array<{id:string;owner_pid:number}>;
    for(const row of rows) {
      let alive=true;
      try {if(this.options.ownerAlive) alive=this.options.ownerAlive(row.owner_pid);else process.kill(row.owner_pid,0);} catch(error){alive=(error as NodeJS.ErrnoException).code!=='ESRCH';}
      if(!alive) this.db.prepare("UPDATE connection_verifications SET state='interrupted',finished_at=?,error=? WHERE id=? AND state IN ('queued','running') AND owner_pid=?").run(new Date().toISOString(),'上次验证结果未确认，未自动重试。再次验证会重新调用模型并使用额度。',row.id,row.owner_pid);
    }
  }
  private async execute(job:VerificationJob,model:ModelConfig):Promise<void> {
    await new Promise<void>(resolve=>setImmediate(resolve));
    let started=false;
    for(let retry=0;retry<3;retry++) {
      try {
        const changed=this.db.prepare("UPDATE connection_verifications SET state='running' WHERE id=? AND state='queued' AND owner_pid=?").run(job.id,process.pid);
        if(Number(changed.changes)!==1)return;
        started=true;break;
      }catch{if(retry<2)await new Promise<void>(resolve=>setTimeout(resolve,25));}
    }
    if(!started) {
      await this.finalize(job.id,{state:'failed',finishedAt:new Date().toISOString(),modelNotStarted:true,error:'模型验证尚未发起：无法记录启动状态，未调用模型。请检查本地存储后主动重试。'});
      return;
    }
    let state:'succeeded'|'failed'='succeeded';
    try {await this.options.verify(model,job.reasoningEffort);}catch{state='failed';}
    const outcome={state,finishedAt:new Date().toISOString(),...(state==='failed'?{error:'模型验证或运行配置启用失败。请检查 Zero 使用的 Codex 环境是否已登录、模型名称和可用额度；这次检查不会自动完成账户登录。'}:{})};
    await this.finalize(job.id,outcome);
  }
  private async finalize(id:string,outcome:VerificationOutcome):Promise<void> {
    // Retrying a database write must never repeat the external model call.
    for(let retry=0;retry<3;retry++) {
      try{this.persistOutcome(id,outcome);return;}catch{if(retry<2)await new Promise<void>(resolve=>setTimeout(resolve,25));}
    }
    this.unrecorded.set(id,outcome);
    console.warn('[zero] Model verification state could not be recorded; the original job retains call custody.');
  }
  private persistOutcome(id:string,outcome:VerificationOutcome):void {
    this.db.prepare("UPDATE connection_verifications SET state=?,finished_at=?,error=? WHERE id=? AND state=? AND owner_pid=?").run(outcome.state,outcome.finishedAt,outcome.error??null,id,outcome.modelNotStarted?'queued':'running',process.pid);
  }
  async close(): Promise<void> {
    if(this.closing)return this.closing;
    this.closed=true;this.closing=(async()=>{await Promise.allSettled([...this.pending]);this.db.close();})();return this.closing;
  }
}
