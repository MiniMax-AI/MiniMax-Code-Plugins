// acp.mjs — mcode acp JSON-RPC client (Node stdio, zero deps)
//
// Spawns `mcode acp` (Agent Client Protocol server) and exposes:
//   - request(method, params)  → Promise<result>
//   - notify(method, params)   → fire-and-forget
//   - on(event, handler)       → subscribe to server notifications
//   - newSession(cwd)          → {sessionId}
//   - loadSession(sid, cwd)    → {} (attach to any TUI session, 0.1.3+)
//   - listSessions()           → {sessions: [{sessionId, cwd, title, updatedAt}], nextCursor}
//   - prompt(sid, text, cbs)   → full lifecycle: init → stream chunks → stopReason
//   - stop()                   → kill subprocess
//
// Event types from mcode 0.1.3 (verified via probe):
//   - session/update {sessionUpdate: "available_commands_update"} → list of slash cmds
//   - session/update {sessionUpdate: "agent_thought_chunk"} → {messageId, content: {type, text}}
//   - session/update {sessionUpdate: "agent_message_chunk"} → {messageId, content: {type, text}}
//   - prompt response: {stopReason: "end_turn" | "max_tokens" | "refusal" | ...}

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_CWD = process.cwd()

// v1.0: mcode 可执行文件动态解析 — 之前硬编码 C:\Users\<author>\... 绝对路径,
//   插件分发到别人机器上必然失效。优先级: env MCODE_CMD > ~/.minimax-code/mcode.cmd > PATH 里的 mcode
function resolveMcodeCmd() {
  if (process.env.MCODE_CMD) return process.env.MCODE_CMD
  if (process.platform === 'win32') {
    const p = join(homedir(), '.minimax-code', 'mcode.cmd')
    if (existsSync(p)) return p
  }
  return 'mcode'
}

export class McodeAcpClient extends EventEmitter {
  constructor({ mcodeCmd = 'mcode', cwd = DEFAULT_CWD, debug = false } = {}) {
    super()
    this.mcodeCmd = mcodeCmd
    this.cwd = cwd
    this.debug = debug
    this.child = null
    this.buf = ''
    this.nextId = 0
    this.pending = new Map()  // id → {resolve, reject, method}
    this.capabilities = null
    this.started = false
  }

  // 启动 subprocess + initialize + 解析 capabilities
  async start() {
    if (this.started) return this.capabilities
    // Windows: 直接 spawn mcode.cmd（Node CreateProcess 知道 .cmd shim，不用 cmd.exe 套）
    //   - cmd.exe /c mcode 会输出 Windows 横幅污染 stdout JSON 解析
    // Linux/macOS: spawn 'mcode' 走 PATH
    // Windows: spawn('cmd.exe', ['/c', 'mcode.cmd', 'acp']) 是 node probe 验证能 work 的姿势
    //  - 直接 spawn mcode.cmd + shell:false → Node 22+ EINVAL（不让直接 CreateProcess .cmd）
    //  - shell:true → Node 内置 cmd.exe 解释，但会输出 Windows 横幅污染 JSON
    //  - cmd.exe /c <.cmd> → cmd.exe 作为父进程，不解释不打印横幅，只 exec mcode.cmd
    const args = process.platform === 'win32'
      ? ['/c', resolveMcodeCmd(), 'acp']
      : ['acp']
    const cmd = process.platform === 'win32' ? 'cmd.exe' : 'mcode'
    this.child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,  // 关键：false 让 cmd.exe 不打印横幅
    })
    this.child.on('error', (e) => this.emit('error', e))
    this.child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal })
      // 拒绝所有 pending
      for (const [id, p] of this.pending) {
        p.reject(new Error(`mcode acp exited (code=${code} signal=${signal})`))
      }
      this.pending.clear()
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => this._onData(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (c) => {
      if (this.debug) process.stderr.write('[acp stderr] ' + c)
    })
    // initialize
    this.capabilities = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'mcode-webui', version: '0.1.0' },
      capabilities: { mcpCapabilities: { http: false, sse: false } },
    })
    this.started = true
    return this.capabilities
  }

  get cmd() {
    return process.platform === 'win32' ? resolveMcodeCmd() : 'mcode'
  }

  // 解析 stdout（每行一条 JSON）
  _onData(chunk) {
    this.buf += chunk
    let nl
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      this._dispatch(line)
    }
  }

  _dispatch(line) {
    let msg
    try { msg = JSON.parse(line) } catch (e) {
      if (this.debug) process.stderr.write('[acp] non-json line: ' + line + '\n')
      return
    }
    // 响应（带 id）
    if (typeof msg.id !== 'undefined' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'acp error'), { data: msg.error }))
        else p.resolve(msg.result)
      }
      return
    }
    // notification（method 但无 id）
    if (msg.method) {
      // 内部 raw 事件
      this.emit('notification', msg)
      // 细粒度事件
      if (msg.method === 'session/update' && msg.params?.update) {
        const u = msg.params.update
        this.emit('sessionUpdate', u)
        if (u.sessionUpdate) this.emit(u.sessionUpdate, u)
      } else {
        this.emit(msg.method, msg.params)
      }
    }
  }

  // 通用 request
  request(method, params) {
    if (!this.child) return Promise.reject(new Error('acp not started'))
    const id = ++this.nextId
    const msg = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      try {
        this.child.stdin.write(JSON.stringify(msg) + '\n')
      } catch (e) {
        this.pending.delete(id)
        reject(new Error(`acp write failed: ${e.message}`))
      }
    })
  }

  notify(method, params) {
    if (!this.child) throw new Error('acp not started')
    const msg = { jsonrpc: '2.0', method, params }
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  // --- 高级 API ---

  async newSession(cwd = this.cwd) {
    return await this.request('session/new', { cwd, mcpServers: [] })
  }

  async loadSession(sessionId, cwd = this.cwd) {
    return await this.request('session/load', { sessionId, cwd, mcpServers: [] })
  }

  async listSessions(cursor) {
    return await this.request('session/list', cursor ? { cursor } : {})
  }

  // 发 prompt + 等 stopReason + 收集 thinking/answer
  // onChunk({kind: 'thought'|'message'|'other'|'done', text?, update?, stopReason?})
  async prompt(sessionId, text, onChunk) {
    // 先清理之前 listener，避免多个 prompt 串
    return await new Promise((resolve, reject) => {
      const result = { thinking: '', answer: '', messageIds: new Set(), stopReason: null, events: [] }
      const onUpdate = (u) => {
        result.events.push(u)
        if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.type === 'text') {
          result.thinking += u.content.text
          if (u.messageId) result.messageIds.add(u.messageId)
          try { onChunk?.({ kind: 'thought', text: u.content.text }) } catch {}
        } else if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
          result.answer += u.content.text
          if (u.messageId) result.messageIds.add(u.messageId)
          try { onChunk?.({ kind: 'message', text: u.content.text }) } catch {}
        } else if (u.sessionUpdate === 'tool_call') {
          // v0.5.bs: mcode acp 工具调用开始 — 透传完整 update 给上层（字段：toolCallId/title/name/status/rawInput）
          try { onChunk?.({ kind: 'tool_call', update: u }) } catch {}
        } else if (u.sessionUpdate === 'tool_call_update') {
          // v0.5.bs: 工具完成 — 透传 rawOutput 等给上层
          try { onChunk?.({ kind: 'tool_update', update: u }) } catch {}
        } else if (u.sessionUpdate === 'usage_update') {
          // v0.5.bx: mcode acp 上下文用量（{used, size, cost} — 当前 session 已用 vs 上限）
          // 字段是累计值（不是 incremental），直接覆盖 cs.context
          try { onChunk?.({ kind: 'usage', update: u }) } catch {}
        } else if (u.sessionUpdate === 'plan_update') {
          // v0.5.bx-9: mcode acp 0.1.5+ 可能发 plan_update 事件（plan 模式 LLM 出方案）
          //   字段: {sessionId, planId, title, summary, options: [{label, description}]}
          //   0.1.4 probe 没发过（available_commands 也没 /plan），但先透传以备未来
          try { onChunk?.({ kind: 'plan_update', update: u }) } catch {}
        } else if (u.sessionUpdate === 'plan_removed') {
          // v0.5.bx-9: 取消 plan 模式
          try { onChunk?.({ kind: 'plan_removed', update: u }) } catch {}
        } else if (u.sessionUpdate === 'current_mode_update') {
          // v0.5.bx-9: mcode 切到 plan/ask 模式时发 — 透传给 webui 决定弹 PlanMode/Ask modal
          try { onChunk?.({ kind: 'mode_update', update: u }) } catch {}
        } else if (u.sessionUpdate === 'goal_update') {
          // v0.5.bx-9: 目标追踪（mcode 0.1.4 acp 没见，但 0.1.5+ 可能加）
          try { onChunk?.({ kind: 'goal_update', update: u }) } catch {}
        } else if (u.sessionUpdate === 'config_option_update') {
          // v0.5.by: mcode acp 0.1.5 推的 config 变化 (如 permissionMode 被改)
          // payload: { sessionId, key, value, ... } — 透传给上层, 上层按 key 分发
          try { onChunk?.({ kind: 'config_option_update', update: u }) } catch {}
        } else if (u.sessionUpdate === 'session_info_update') {
          // v0.5.by: mcode acp 0.1.5 推的 session info 变化 (mcode docs 没列具体字段, 透传)
          try { onChunk?.({ kind: 'session_info_update', update: u }) } catch {}
        } else {
          try { onChunk?.({ kind: 'other', update: u }) } catch {}
        }
      }
      this.on('sessionUpdate', onUpdate)
      // 发 prompt
      this.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      }).then((r) => {
        result.stopReason = r?.stopReason || 'end_turn'
        // v0.5.bx: 捕获 usage 字段（Gcm schema: totalTokens/inputTokens/outputTokens/thoughtTokens/cachedReadTokens/cachedWriteTokens）
        // mcode acp 0.1.3 把 usage 放在 session/prompt response 里，不发独立 usage_update event
        if (r && r.usage) result.usage = r.usage
        // v0.5.bx-7: debug — 看 mcode 0.1.4 实际 response 结构
        if (process.env.MCODE_ACP_DEBUG) {
          console.log('[acp.prompt.response]', JSON.stringify({
            stopReason: r?.stopReason,
            hasUsage: !!r?.usage,
            usageKeys: r?.usage ? Object.keys(r.usage) : null,
            usage: r?.usage,
            respKeys: r ? Object.keys(r) : null,
            fullResp: r,
          }).slice(0, 2000))
        }
        this.off('sessionUpdate', onUpdate)
        try { onChunk?.({ kind: 'done', stopReason: result.stopReason, usage: result.usage }) } catch {}
        resolve(result)
      }).catch((e) => {
        this.off('sessionUpdate', onUpdate)
        reject(e)
      })
    })
  }

  stop() {
    if (this.child) {
      try { this.child.kill() } catch {}
      this.child = null
    }
    this.started = false
  }

  // 别名：跟 child_process 的 child.kill() 接口一致，/api/stop 能直接用
  kill() { this.stop() }
}
