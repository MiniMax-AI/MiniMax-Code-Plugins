import { durationLabel } from './limits.mjs';
export function safeDetail(value){return String(value??'').replace(/(Bearer\s+)\S+/gi,'$1[REDACTED]').replace(/((?:api[_-]?key|access[_-]?token|token|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,'$1[REDACTED]').slice(0,1500);}
export function agentFailure(status,{maxSteps,timeoutMs,exitCode=null,cause='',sessionId,turnId,providerCode,category}={}){
 const detail={code:'MCODE_FAILED',status,maxSteps,timeoutMs,exitCode,sessionId,turnId,providerCode,category,cause:safeDetail(cause)};
 if(status==='limit_exceeded')Object.assign(detail,{code:'AGENT_STEP_LIMIT',message:`达到单个 Agent 的 ${maxSteps} 步执行上限，未取得成功结果。`,suggestion:'提高每节点步数上限后恢复，或拆分任务。失败节点会从头重跑。'});
 else if(status==='timeout')Object.assign(detail,{code:'AGENT_TIMEOUT',message:`单个 Agent 超过 ${durationLabel(timeoutMs)} 执行时限，已停止。`,suggestion:'提高每节点超时后恢复，或缩小单个节点的任务范围。'});
 else if(status==='cancelled')Object.assign(detail,{code:'MCODE_CANCELLED',message:'MCode 返回任务已取消。',suggestion:'确认取消原因后再恢复。'});
 else if(status==='succeeded'&&exitCode!==0)Object.assign(detail,{code:'MCODE_EXIT',message:`MCode 返回成功事件，但进程异常退出（退出码 ${exitCode??'未知'}），结果未采纳。`,suggestion:'检查 MCode 进程日志及退出原因。'});
 else Object.assign(detail,{message:detail.cause||`MCode 未成功完成（状态 ${status}，退出码 ${exitCode??'未知'}）。`,suggestion:'检查具体原因和节点日志，修复后再恢复。'});
 return detail;
}
export function failureError(details,usage=null){return Object.assign(new Error(details.message),{details,usage});}
