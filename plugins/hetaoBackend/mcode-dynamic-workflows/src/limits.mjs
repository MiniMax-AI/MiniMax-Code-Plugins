import { check } from './common.mjs';
export const DEFAULT_LIMITS=Object.freeze({maxSteps:120,stepTimeoutMs:30*60_000,runTimeoutMs:2*60*60_000});
export const LEGACY_LIMITS=Object.freeze({maxSteps:30,stepTimeoutMs:10*60_000,runTimeoutMs:30*60_000});
export const LIMIT_SCHEMAS={maxSteps:{type:'integer',minimum:1,maximum:1000,description:'每个 Agent 的模型决策步数上限，默认 120；不是工作流节点数量。'},stepTimeoutMs:{type:'integer',minimum:1000,maximum:7_200_000,description:'每个 Agent 的超时毫秒数，默认 1800000（30 分钟）。'},runTimeoutMs:{type:'integer',minimum:1000,maximum:86_400_000,description:'每次执行或恢复的工作流整体时限，默认 7200000（120 分钟）。'}};
export function resolveLimits(input={},base=DEFAULT_LIMITS){const result={};for(const [key,schema]of Object.entries(LIMIT_SCHEMAS)){const value=input[key]===undefined?base[key]:input[key];check(Number.isInteger(value)&&value>=schema.minimum&&value<=schema.maximum,`${key} 必须是 ${schema.minimum}–${schema.maximum} 范围内的整数`);result[key]=value;}return result;}
export const runLimits=run=>resolveLimits(run,LEGACY_LIMITS);
export const durationLabel=ms=>ms%60000===0?`${ms/60000} 分钟`:`${ms/1000} 秒`;
