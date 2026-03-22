import type { RoutingTier, RoutingRequest, OpenAIMessage, OpenAIContentPart } from './types.js'

const CODE_KEYWORDS =
  /\b(function|class|interface|def |import |require\(|void |async |await|const |let |var |return |throw |try |catch |finally )\b/
const CODE_TASK_KEYWORDS =
  /\b(debug|fix|implement|refactor|test|lint|compile|build|review|optimize)\b.*\b(code|function|class|method|script|snippet|bug|error|exception|algorithm|program|module)\b/i
const CODE_FENCE_RE = /```/

const COMPLEX_KEYWORDS =
  /\b(analyze|analyse|explain|compare|evaluate|architecture|design|strategy|research|summarize|summarise|assess|critique|review)\b/i

const SIMPLE_GREETING_RE = /^(hi|hello|hey|thanks|thank you|ok|okay|yes|no|sure|great)\b/i
const SIMPLE_QA_RE = /^(what is|what's|who is|who's|when is|when was|where is|where's)\b/i

/** Estimate token count from character count (rough 4 chars/token heuristic) */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function extractText(content: string | OpenAIContentPart[] | null): string {
  if (content === null) return ''
  if (typeof content === 'string') return content
  return content
    .filter((p): p is OpenAIContentPart & { type: 'text' } => p.type === 'text')
    .map((p) => p.text ?? '')
    .join(' ')
}

function getLastUserMessage(messages: OpenAIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg !== undefined && msg.role === 'user') {
      return extractText(msg.content)
    }
  }
  return ''
}

function totalMessageText(messages: OpenAIMessage[]): string {
  return messages.map((m) => extractText(m.content)).join(' ')
}

/**
 * Classify a routing request into a tier.
 *
 * Tiers: SIMPLE | STANDARD | COMPLEX | CODE
 * This is a deterministic heuristic — no ML.
 */
export function classifyRequest(request: RoutingRequest): RoutingTier {
  const lastUserMsg = getLastUserMessage(request.messages)
  const allText = totalMessageText(request.messages)
  const totalTokens = estimateTokens(allText)

  // CODE: explicit code fences, language keywords, or coding task descriptions
  if (
    CODE_FENCE_RE.test(allText) ||
    CODE_KEYWORDS.test(lastUserMsg) ||
    CODE_TASK_KEYWORDS.test(lastUserMsg)
  ) {
    return 'CODE'
  }

  // COMPLEX: analysis keywords or very long context
  if (COMPLEX_KEYWORDS.test(lastUserMsg) || totalTokens > 2000) {
    return 'COMPLEX'
  }

  // SIMPLE: short greeting/Q&A
  if (
    totalTokens < 200 &&
    (SIMPLE_GREETING_RE.test(lastUserMsg.trim()) || SIMPLE_QA_RE.test(lastUserMsg.trim()))
  ) {
    return 'SIMPLE'
  }

  return 'STANDARD'
}
