"use strict";
const { randomUUID } = require('node:crypto');

// Opt-in protocol. Ordinary shell exit/wake semantics remain untouched.
function settings(input) {
  const mode = input.resultMode;
  if (mode === undefined) return undefined;
  if (mode === 'exitCode') {
    if (input.action !== 'shell') throw new Error('resultMode requires action=shell');
    return undefined;
  }
  if (mode !== 'readiness') throw new Error('resultMode must be exitCode or readiness');
  if (input.action !== 'shell') throw new Error('readiness resultMode requires action=shell');
  const wakeOn = input.wakeOn ?? 'success', stopOn = input.stopOn ?? 'success';
  if (!['success', 'always'].includes(wakeOn)) throw new Error('readiness wakeOn must be success or always; errors always report');
  if (!['success', 'never'].includes(stopOn)) throw new Error('readiness stopOn must be success or never');
  return { resultMode: mode, wakeOn, stopOn };
}
function classify(result) {
  const error = summary => ({ state: 'error', summary });
  if (result.error) return error(String(result.error).slice(0, 1000));
  if (result.killed) return error('检查命令超时或被终止');
  if (result.truncated) return error('检查命令输出超过执行器上限，无法验证状态');
  if (result.code !== 0) return error(`检查命令退出码 ${result.code ?? '未知'}`);
  const raw = String(result.stdout ?? '');
  if (Buffer.byteLength(raw, 'utf8') > 8192) return error('readiness stdout 超过 8192 字节');
  let value;
  try { value = JSON.parse(raw); } catch { return error('readiness stdout 必须是一个合法 JSON 状态对象'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !['pending', 'ready', 'error'].includes(value.state)
      || typeof value.summary !== 'string' || !value.summary.trim() || value.summary.length > 1000
      || Object.keys(value).some(key => !['state', 'summary'].includes(key))) {
    return error('readiness 需要 state=pending|ready|error 和非空 summary（最多 1000 字符），不接受其他字段');
  }
  return { state: value.state, summary: value.summary };
}
function notice(task, now, state, reason, summary, attemptId) {
  if (task.readinessNotice) return;
  if (state === 'error') task.failedAt = now.toISOString();
  task.readinessNotice = {
    id: attemptId ?? task.runAttemptId ?? randomUUID(), state, reason, summary,
    createdAt: now.toISOString(), sessionFile: task.runOwner?.sessionFile ?? task.pendingWake?.sessionFile ?? task.lastReadiness?.sessionFile ?? task.sessionFile,
    ownerPid: task.runOwner?.pid ?? task.pendingWake?.ownerPid,
  };
}
function finish(task, now, result, mayAct) {
  const reading = result.readiness ?? classify(result);
  result.readiness = reading;
  result.attemptId ??= task.runAttemptId;
  if (!mayAct) return;
  const fingerprint = result.wakeOnChangeFingerprint;
  const samePending = reading.state === 'pending' && task.lastReadiness?.state === 'pending'
    && task.lastReadiness.summary === reading.summary && task.lastReadiness.fingerprint === fingerprint;
  result.readinessQuiet = samePending;
  task.lastReadiness = { ...reading, fingerprint, sessionFile: task.runOwner?.sessionFile ?? task.sessionFile, checkedAt: now.toISOString(), count: (task.lastReadiness?.count ?? 0) + 1 };
  if (reading.state === 'error') {
    notice(task, now, 'error', 'checker-error', reading.summary);
    task.enabled = false; task.status = 'failed'; task.lastError = reading.summary;
    task.stopReason = 'Readiness checker failed; repair and explicitly enable to resume';
    task.nextRun = undefined;
  }
}
function endWaiting(task, now, reason, attemptId) {
  if (task.resultMode !== 'readiness' || ['error', 'ready', 'ended'].includes(task.lastReadiness?.state)) return;
  const summary = reason === 'expiresIn' ? '等待期限已用尽，条件尚未满足' : reason === 'maxRuns' ? '检查次数已用尽，条件尚未满足' : '本次等待检查已结束，条件尚未满足';
  task.lastReadiness = { ...(task.lastReadiness ?? {}), state: 'ended', summary, checkedAt: now.toISOString(), reason };
  notice(task, now, 'ended', reason, summary, attemptId);
}
function clearTracking(task) {
  delete task.lastReadiness; delete task.readinessNotice;
}
module.exports = { settings, classify, finish, endWaiting, clearTracking };
