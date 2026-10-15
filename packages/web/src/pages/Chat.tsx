/**
 * ChatPage — owner: web-ai-pages.
 * 左侧会话列表 + 右侧流式对话（SSE：text 增量 + 步骤/工具调用时间线）。
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AgentStep, ChatMessage, ChatSession } from '@aia/shared';
import { api } from '../api/client';
import { toApiError, useAgentStream, useAsync, type ToolEvent } from '../api/hooks';
import { fmtDateTime, fmtRelative } from '../format';
import { Alert, Button, Card, ConfirmDialog, Empty, ErrorAlert, Loading, Textarea, useToast } from '../components/ui';
import { Markdown } from '../components/markdown/Markdown';

const QUICK_COMMANDS = [
  '分析我的持仓，指出风险与机会',
  '帮我看下我的标的里有哪只被低估',
  '把贵州茅台加入我的标的',
  '本月各市场预算还剩多少？',
];

export function ChatPage() {
  const toast = useToast();
  const [sessionNonce, setSessionNonce] = useState(0);
  const [messageNonce, setMessageNonce] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChatSession | null>(null);
  const [deleting, setDeleting] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const autoCreateRef = useRef(false);

  const sessions = useAsync(() => api.chat.sessions(), [sessionNonce]);
  const messages = useAsync(
    () => (activeId ? api.chat.messages(activeId) : Promise.resolve([] as ChatMessage[])),
    [activeId, messageNonce],
  );
  const stream = useAgentStream();
  const settings = useAsync(() => api.settings.get(), []);
  const llmMissing = settings.data !== null && !settings.data.hasApiKey;

  const sessionList = sessions.data ?? [];
  const activeSession = sessionList.find((session) => session.id === activeId) ?? null;
  const serverMessages = (messages.data ?? []).filter((message) => message.role === 'user' || message.role === 'assistant');
  const pendingVisible = pending !== null && !serverMessages.some((message) => message.role === 'user' && message.content === pending);

  /* 首次进入若无任何会话，自动创建一个空会话（每次进入只尝试一次） */
  useEffect(() => {
    if (activeId || !sessions.data) return;
    if (sessions.data.length > 0) {
      setActiveId(sessions.data[0]!.id);
      return;
    }
    if (autoCreateRef.current) return;
    autoCreateRef.current = true;
    setCreating(true);
    api.chat
      .createSession()
      .then((session) => {
        setActiveId(session.id);
        setSessionNonce((value) => value + 1);
      })
      .catch((error) => toast.error('创建会话失败', toApiError(error).message))
      .finally(() => setCreating(false));
  }, [activeId, sessions.data, toast]);

  /* 服务端消息回来后清掉本地的乐观气泡 */
  useEffect(() => {
    if (!pending) return;
    const stored = (messages.data ?? []).some((message) => message.role === 'user' && message.content === pending);
    if (stored) setPending(null);
  }, [messages.data, pending]);

  /* 自动滚动到底部 */
  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [serverMessages.length, stream.text, stream.steps.length, stream.toolEvents.length, pendingVisible, activeId]);

  async function newSession() {
    setCreating(true);
    try {
      const session = await api.chat.createSession();
      setActiveId(session.id);
      setSessionNonce((value) => value + 1);
    } catch (error) {
      toast.error('创建会话失败', toApiError(error).message);
    } finally {
      setCreating(false);
    }
  }

  async function removeSession() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.chat.removeSession(deleteTarget.id);
      toast.success('会话已删除', deleteTarget.title || '未命名会话');
      if (activeId === deleteTarget.id) setActiveId(null);
      setDeleteTarget(null);
      setSessionNonce((value) => value + 1);
    } catch (error) {
      toast.error('删除失败', toApiError(error).message);
    } finally {
      setDeleting(false);
    }
  }

  async function send() {
    const content = input.trim();
    if (!content || sending || !activeId) return;
    setInput('');
    setSending(true);
    let targetId = activeId;
    try {
      // 会话标题取首条用户消息前 20 字：空会话重建为带标题的会话
      if (activeSession && activeSession.messageCount === 0) {
        try {
          const recreated = await api.chat.createSession(content.slice(0, 20));
          await api.chat.removeSession(activeId);
          targetId = recreated.id;
          setActiveId(recreated.id);
        } catch {
          targetId = activeId;
        }
      }
      setPending(content);
      const final = await stream.start(`/chat/sessions/${targetId}/messages`, { content });
      if (final.error) {
        setPending(null);
        toast.error('发送失败', final.error);
      }
    } catch (error) {
      setPending(null);
      toast.error('发送失败', toApiError(error).message);
    } finally {
      setSending(false);
      setSessionNonce((value) => value + 1);
      setMessageNonce((value) => value + 1);
    }
  }

  return (
    <div className="chat-layout">
      <Card
        title={`会话（${sessionList.length}）`}
        actions={
          <Button size="sm" loading={creating} onClick={() => void newSession()}>
            新建
          </Button>
        }
        padded={false}
      >
        <div className="scroll-y" style={{ maxHeight: '62vh', padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <ErrorAlert error={sessions.error} onRetry={sessions.reload} />
          {sessions.loading && !sessions.data && <Loading label="加载会话…" />}
          {sessionList.map((session) => (
            <div className="flex center gap-1" key={session.id}>
              <button
                type="button"
                className={`nav-item ${session.id === activeId ? 'active' : ''}`}
                style={{ flex: 1, minWidth: 0 }}
                title={session.title || '未命名会话'}
                onClick={() => setActiveId(session.id)}
              >
                <span className="truncate">{session.title || '未命名会话'}</span>
              </button>
              <Button size="sm" variant="ghost" className="btn-icon" title="删除会话" onClick={() => setDeleteTarget(session)}>
                ×
              </Button>
            </div>
          ))}
          {!sessions.loading && sessionList.length === 0 && (
            <div className="tiny mute" style={{ padding: 8 }}>
              暂无会话
            </div>
          )}
        </div>
      </Card>

      <Card
        title={
          <span className="center gap-2">
            {activeSession?.title || '新会话'}
            {activeSession && (
              <span className="tiny mute">
                共 {activeSession.messageCount} 条消息 · {fmtRelative(activeSession.updatedAt)}
              </span>
            )}
          </span>
        }
        padded={false}
      >
        <div className="chat-messages" ref={scrollRef}>
          <ErrorAlert error={messages.error} onRetry={messages.reload} />
          {llmMissing && (
            <Alert tone="warn">
              尚未配置 LLM API Key，Agent 无法回复。请前往 <Link to="/settings">设置</Link> 填写 Base URL 与 API Key 后重试。
            </Alert>
          )}
          {messages.loading && !messages.data && <Loading label="加载消息…" />}

          {!messages.loading && serverMessages.length === 0 && !pendingVisible && !sending && (
            <Empty
              title="开始和 AI 投资顾问对话"
              hint="Agent 可以调用工具读写你的资产、标的、建议与设置，例如「分析我的持仓」「把某只股票加入我的标的」。"
            />
          )}

          {serverMessages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}

          {pendingVisible && (
            <div className="msg msg-user">
              <div className="msg-avatar">我</div>
              <div className="msg-bubble">{pending}</div>
            </div>
          )}

          {(sending || stream.running) && (
            <div className="msg msg-assistant">
              <div className="msg-avatar">AI</div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="msg-bubble md-bubble">
                  {/* 流式回复按 Markdown 渲染；未闭合的代码围栏也不会丢文字。 */}
                  {stream.text ? (
                    <Markdown text={stream.text} variant="compact" metrics={false} />
                  ) : stream.steps.length === 0 ? (
                    '正在思考…'
                  ) : null}
                  {stream.running && <span className="typing-dot" style={{ marginLeft: 4 }} />}
                </div>
                {(stream.toolEvents.length > 0 || stream.steps.length > 0) && (
                  <div className="run-panel mt-2">
                    {stream.toolEvents.length > 0 && (
                      <>
                        <div className="tiny mute mb-1">工具调用（{stream.toolEvents.length}）</div>
                        <ToolTimeline events={stream.toolEvents} />
                      </>
                    )}
                    {stream.steps.length > 0 && (
                      <>
                        {stream.toolEvents.length > 0 && <div className="divider" />}
                        <div className="tiny mute mb-1">执行步骤（{stream.steps.length}）</div>
                        <StepTimeline steps={stream.steps} />
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: '0 16px 10px' }}>
          <div className="toolbar">
            {QUICK_COMMANDS.map((command) => (
              <Button key={command} size="sm" variant="ghost" disabled={sending} onClick={() => setInput(command)}>
                {command}
              </Button>
            ))}
          </div>
        </div>

        <div className="chat-composer">
          <Textarea
            value={input}
            rows={2}
            placeholder="给 Agent 下达指令…（Enter 发送，Shift+Enter 换行）"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <div className="flex gap-1">
            {sending && (
              <Button variant="ghost" onClick={stream.cancel}>
                中断
              </Button>
            )}
            <Button variant="primary" loading={sending} disabled={!input.trim() || !activeId} onClick={() => void send()}>
              发送
            </Button>
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={deleteTarget !== null}
        danger
        busy={deleting}
        title="删除会话"
        confirmLabel="删除"
        message={
          <>
            确认删除会话 <strong>{deleteTarget?.title || '未命名会话'}</strong> 及其全部消息？此操作不可撤销。
          </>
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void removeSession()}
      />
    </div>
  );
}

/* ────────────────────────────── 消息气泡 ─────────────────────────────────── */

function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';
  return (
    <div className={`msg ${isUser ? 'msg-user' : 'msg-assistant'}`}>
      <div className="msg-avatar">{isUser ? '我' : 'AI'}</div>
      <div style={{ minWidth: 0, flex: 1 }}>
        {/* 用户消息是纯文本；AI 回复是 Markdown 报告，需要分层渲染。 */}
        {isUser ? (
          <div className="msg-bubble">{message.content || '（空消息）'}</div>
        ) : (
          <div className="msg-bubble md-bubble">
            <Markdown text={message.content || '（空消息）'} variant="compact" />
          </div>
        )}
        <div className="tiny mute mt-1">{fmtDateTime(message.createdAt)}</div>
        {message.steps.length > 0 && (
          <details className="mt-1">
            <summary className="tiny mute" style={{ cursor: 'pointer' }}>
              执行步骤（{message.steps.length}）· 工具调用
            </summary>
            <div className="run-panel mt-1">
              <StepTimeline steps={message.steps} />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

/** 小字时间线：步骤 + 工具名 + 参数/结果摘要。 */
function StepTimeline({ steps }: { steps: AgentStep[] }) {
  return (
    <div className="step-list">
      {steps.map((step) => (
        <div className="step" key={step.id}>
          <span className={`step-dot ${step.status}`} />
          <div style={{ minWidth: 0 }}>
            <div className="step-label">
              {step.label}
              {step.toolName && <span className="mute mono tiny"> · {step.toolName}</span>}
            </div>
            {step.detail && <div className="step-detail">{step.detail.slice(0, 300)}</div>}
            {step.toolArgs && <div className="step-detail mono">参数：{step.toolArgs.slice(0, 200)}</div>}
            {step.toolResult && <div className="step-detail">结果：{step.toolResult.slice(0, 240)}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 工具调用列表：工具名 + 参数摘要 + 结果摘要（来自 tool-call / tool-result 事件）。 */
function ToolTimeline({ events }: { events: ToolEvent[] }) {
  return (
    <div className="step-list">
      {events.map((event) => (
        <div className="step" key={event.id}>
          <span className={`step-dot ${event.ok === undefined ? 'running' : event.ok ? 'done' : 'error'}`} />
          <div style={{ minWidth: 0 }}>
            <div className="step-label">
              <span className="mono">{event.name}</span>
              {event.ok === undefined && <span className="mute tiny"> · 调用中</span>}
              {event.ok === false && <span className="tiny"> · 失败</span>}
            </div>
            {event.args !== undefined && event.args !== null && (
              <div className="step-detail mono">参数：{summarize(event.args)}</div>
            )}
            {event.summary && <div className="step-detail">结果：{event.summary.slice(0, 240)}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

function summarize(value: unknown, max = 200): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
