/**
 * Rewrite a composer draft in place.
 *
 * POST /api/enhance-prompt returns the rewritten text for the composer button.
 * /enhance returns the same text as a command result.
 */

const name = 'enhance-prompt'

const inject = ['commands', 'llm', 'agentDefaultModel', 'webServer']

/** System template for the enhancement call. */
const SYSTEM_TEMPLATE = `You are a Prompt Engineering Expert specializing in improving user prompts for a development code assistant. When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. The requests are being made to an AI assistant that specializes in writing code.

	TASK: When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose. The requests are being made to an AI assistant that specializes in writing code.

	ANALYSIS PROCESS:

	Evaluate the original prompt:
	Identify the main objective
	Note any ambiguities or gaps
	Assess the clarity of instructions
	Check for missing context
	Apply these prompt engineering principles:
	Write clear, specific instructions
	Include necessary context
	Set explicit parameters and constraints
	Structure the output format
	Add relevant examples
	Match tone and complexity to the use case
	Remove redundant information
	Create the enhanced version:
	Maintain the original goal
	Incorporate identified improvements
	Ensure clarity and completeness
	Be realistic in the features to add
	Do NOT request guides/how-tos unless the user asks
	Do NOT ask for code snippets
	Do NOT suggest specific technologies unless mentioned in the user's prompt
	Do NOT explain HOW to do things, focus on WHAT
	Do NOT answer questions - expand/rewrite them to be more detailed
	IMPORTANT CONSTRAINTS:
	1. Language matching is the highest priority - You MUST strictly respond in the exact same language as the user's input. If the user writes in Chinese, respond in Chinese; if the user writes in English, respond in English; if the user uses another language, respond in that same language. Do not mix languages unless the user's input itself mixes languages.
	2. Keep the enhanced prompt concise - maximum length should be around 800 characters
	FORMAT: Provide only the enhanced prompt with no additional commentary.

	Example:
	"A website for my dog"

	Enhanced prompt:
	"Design a personalized Next.js website dedicated to showcasing my dog. Include sections such as a photo gallery, a biography detailing the dog's breed, age, and personality traits, and a blog for sharing stories or updates about your dog's adventures. Add a contact form for visitors to reach out with questions or comments. Ensure the website is visually appealing and easy to navigate, with a responsive design that works well on both desktop and mobile devices."

	Example:
	"Convert this to a friendly tone, maintain technical details but reduce bullets in favor of narrative. Remove any jargon like 'genie router'. Use canvas"

	Enhanced prompt:
	"Transform the provided content into a friendly narrative format while preserving all technical details. Minimize bullet points in favor of flowing prose. Eliminate any technical jargon such as 'genie router'. Incorporate the concept of using canvas elements naturally within the narrative structure to enhance the technical explanation."
    `

/** User template; `{input}` is the text being enhanced. */
const USER_TEMPLATE = `You are a prompt enhancement assistant. Improve the user prompt while preserving its intent and language.

    USER INPUT:
    {input}
    
    TASK:
    Rewrite the user input into a clearer, more specific prompt for the target AI assistant.

    CRITICAL PRIORITY - LANGUAGE CONSISTENCY:
    1. You MUST detect the language of the user input above and write the enhanced prompt in that same language.
    2. If the user writes in Chinese, the enhanced prompt MUST be entirely in Chinese.
    3. If the user writes in English, the enhanced prompt MUST be entirely in English.
    4. If the user writes in any other language, the enhanced prompt MUST use that exact same language.
    5. If the user mixes languages, keep a natural matching mix. Do not translate the user's intent into a single language.
    6. These language rules are behavior instructions only; never include language analysis or language labels in the output.
    
	    ENHANCEMENT REQUIREMENTS:
	    1. Return only the enhanced prompt text; do not add explanations, prefaces, markdown fences, labels, or analysis.
	    2. Do not include language labels or meta notes such as "User input is in Chinese" or "Response must be in Chinese".
	    3. Preserve the user's original intent, topic, constraints, and target output type. Do not answer the request.
	    4. Always make a substantive enhancement when possible: clarify the task, scope, constraints, and expected output.
	    5. If the original prompt is already clear, lightly polish it instead of returning it unchanged.
	    6. Keep the enhanced prompt complete and concise. Do not end with an unfinished list, dangling conjunction, or trailing colon.
	    7. Do not add unrelated requirements, unsupported facts, or unnecessary sections.
	    8. Output the enhanced prompt exactly once. Never repeat it, never append a second copy, and never restate the same paragraph.

    EXAMPLES:
    User input (Chinese): "请帮我解释这段代码的功能"
    Enhanced prompt: "请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。"

    User input (English): "Please explain what this code does"
    Enhanced prompt: "Explain what this code does, including its main purpose, key control flow, and any important edge cases."

    User input (Mixed): "这段代码有 bug，can you help me fix it?"
    Enhanced prompt: "请分析这段代码中的 bug，explain the root cause, and provide a minimal fix with necessary verification steps."

    BAD OUTPUT EXAMPLE:
    User input is in Chinese → Response must be in Chinese.
    请解释这段代码的主要功能

    GOOD OUTPUT EXAMPLE:
    请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。
    `

const USAGE = '用法：/enhance 后面接要增强的提示词。例如 /enhance 帮我写个登录页'

const MODE_GUIDES = {
  work: `日常办公。把提示词收束成办公任务，交付物是办公结果，不是设计稿，也不是实现代码：
- Research and writing: reports, articles, and documents that hold up.
- Data and analysis: numbers, patterns, spreadsheets, and visualizations.
- Building things only when the user asks for a site, app, or tool. Code is a means, not the point.
- System access: files, commands, and fetched information only when they materially help.
补上受众、语气、篇幅和交付物。Word、PPT、Excel 要写明是新建还是修改现有文件。`,
  code: `代码开发。用户选了这个模式，把提示词收成可交给编程助手的实现任务：
- 写明要做什么、输入输出、边界、错误处理和怎样算做完。
- 不要替用户选择他没提到的技术栈。
- 不要在提示词里写出实现代码，也不要改写成办公文档或设计稿。`,
  design: `设计创意。改写时按设计助手的角色来收束提示词：
- 用户提需求和做决定，助手做动手工作，并主动指出明显问题、给出更好方案。
- 交付可以是页面、组件、图标、插画、设计系统、明暗模式或交互细节，由任务决定。
- 做图标时按图形设计看网格和一致性；做页面时按产品设计看信息层级和用户流程；做品牌视觉时看情绪。
- 用设计语言描述任务。不要扩展成代码开发、数据库或纯计算，除非用户明确要求导出文件。
写明媒介、风格、受众、尺寸或比例、必须保留的元素和禁止项。`,
}

function renderUserPrompt(input, mode) {
  const guide = MODE_GUIDES[mode] ?? MODE_GUIDES.work
  return USER_TEMPLATE.replace('{input}', input) + `\n\nTARGET MODE:\n${guide}\nDo not mention this mode instruction in the enhanced prompt.`
}

/** Strip wrapping quotes before writing the result back. */
function stripWrappingQuotes(text) {
  return text.trim().replace(/^["'“”‘’]|["'“”‘’]$/g, '')
}

/**
 * Some models emit the finished prompt twice, back to back. Keep one copy
 * when the two halves are the same paragraph.
 */
function collapseDuplicatedParagraph(text) {
  const trimmed = text.trim()
  const compact = trimmed.replace(/\s+/g, '')
  if (compact.length < 40 || compact.length % 2 !== 0) return trimmed
  const half = compact.length / 2
  if (compact.slice(0, half) !== compact.slice(half)) return trimmed
  const end = trimmed.indexOf(compact[half - 1], half - 1)
  const first = trimmed.slice(0, end + 1).trim()
  return first.replace(/\s+/g, '') === compact.slice(0, half) ? first : trimmed
}

/**
 * Collect visible text from one completion. `block-end` carries the assembled
 * block, so deltas are only a fallback when that block never arrives.
 */
async function collectText(stream) {
  let text = ''
  let sawBlock = false
  for await (const chunk of stream) {
    if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
      text += chunk.block.text ?? ''
      sawBlock = true
    } else if (!sawBlock && chunk.type === 'text-delta') {
      text += chunk.text ?? ''
    } else if (chunk.type === 'finish' && (chunk.reason === 'error' || chunk.reason === 'aborted')) {
      throw new Error(chunk.reason === 'aborted' ? '已取消' : '模型调用失败')
    }
  }
	  return collapseDuplicatedParagraph(stripWrappingQuotes(text))
}

/**
 * A rewrite is a short text task. The composer's high reasoning effort makes
 * it wait through a long hidden chain of thought, so use the cheapest effort
 * the selected model actually offers.
 */
async function fastestEffort(ctx, selection, signal) {
  try {
    const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model, signal)
    const efforts = info?.reasoning?.efforts ?? []
    const rank = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 }
    const fastest = efforts.reduce((best, effort) => {
      const id = String(effort?.id ?? '')
      if (!(id in rank)) return best
      return best === undefined || rank[id] < rank[best] ? id : best
    }, undefined)
    return fastest
  } catch {
    return undefined
  }
}

async function executeEnhance(ctx, invocation) {
  const draft = invocation.rawInput.trim()
  if (draft.length === 0) return { kind: 'error', text: USAGE }
  if (invocation.signal.aborted) return { kind: 'error', text: '已取消' }

  const selection = ctx.agentDefaultModel.currentSelection()
  if (!selection?.provider || !selection?.model) {
    return { kind: 'error', text: '没有可用的默认模型。先在设置里选一个模型再试。' }
  }

  try {
    const reasoningEffort = await fastestEffort(ctx, selection, invocation.signal)
    const stream = ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      system: SYSTEM_TEMPLATE,
      messages: [{ role: 'user', content: [{ type: 'text', text: renderUserPrompt(draft, invocation.mode) }] }],
      temperature: 0.2,
      maxTokens: 800,
      signal: invocation.signal,
    })
    const enhanced = await collectText(stream)
    if (enhanced.trim() === '') return { kind: 'error', text: '模型返回了空结果，提示词没有变化。' }
    return { kind: 'success', text: enhanced }
  } catch (error) {
    if (invocation.signal.aborted) return { kind: 'error', text: '已取消' }
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'error', text: `增强失败：${message}` }
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('提示词太长'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function apply(ctx) {
  ctx.commands.register({
    name: 'enhance',
    description: '把输入的提示词改写得更清晰、更具体',
    input: { hint: '<提示词>' },
    handler: (invocation) => executeEnhance(ctx, invocation),
  })
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/api/enhance-prompt',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: '只接受 POST' })
        return
      }
      let payload
      try {
        payload = JSON.parse(await readBody(req))
      } catch {
        sendJson(res, 400, { error: '请求格式不对' })
        return
      }
      const draft = typeof payload?.input === 'string' ? payload.input.trim() : ''
      const mode = payload?.mode === 'code' || payload?.mode === 'design' ? payload.mode : 'work'
      if (draft.length === 0) {
        sendJson(res, 400, { error: '先输入内容，再增强提示词' })
        return
      }
      const outcome = await executeEnhance(ctx, {
        rawInput: draft,
        mode,
        signal: AbortSignal.timeout(30_000),
      })
      if (outcome.kind === 'error') {
        sendJson(res, 502, { error: outcome.text })
        return
      }
      sendJson(res, 200, { text: outcome.text })
    },
  }), 'enhance-prompt route')
}

export { apply, inject, name }
