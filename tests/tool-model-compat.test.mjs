import test from 'node:test'
import assert from 'node:assert/strict'
import { toolCompatibleRequest, toolModelSelection } from '../apps/api/src/operations/gateway.mjs'

test('Luna function calls explicitly disable incompatible default reasoning without changing plain chat or search', () => {
  const tool = { type: 'function', function: { name: 'workspace_list_files' } }
  const input = { model: 'gpt-5.6-luna', tools: [tool], messages: [{ role: 'user', content: 'test' }] }
  assert.equal(toolCompatibleRequest(input).reasoning_effort, 'none')
  assert.equal(input.reasoning_effort, undefined)
  for (const body of [
    { model: 'gpt-5.6-luna', messages: input.messages, reasoning_effort: 'high' },
    { model: 'gpt-5.6-luna', tools: [{ type: 'web_search_preview' }] },
    { model: 'other-model', tools: [tool], reasoning_effort: 'high' },
  ]) assert.strictEqual(toolCompatibleRequest(body), body)
  const fallback = { ...input, model: 'claude-haiku-4.5' }
  assert.equal(toolCompatibleRequest(fallback).reasoning_effort, undefined)
})

test('GPT completion budget conversion preserves input and other model protocols', () => {
  for (const model of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.5', 'gpt-5.6-luna']) {
    const input = { model, max_tokens: 4096, tools: [{ type: 'function' }] }
    const output = toolCompatibleRequest(input)
    assert.equal(output.max_completion_tokens, 4096)
    assert.equal(output.max_tokens, undefined)
    assert.equal(input.max_tokens, 4096)
    assert.equal(toolCompatibleRequest({ ...input, max_completion_tokens: 32 }).max_completion_tokens, 32)
  }
  const claude = { model: 'claude-opus-5', max_tokens: 4096 }
  assert.strictEqual(toolCompatibleRequest(claude), claude)
})

test('GPT 6.1 tool requests use configured fallback without changing chat or policy', () => {
  const selection = {model:'gpt-6.1-sol',fallback:'claude-opus-5'}
  const policy = {tiers:{cheap:'gpt-5.5'}}
  const tools = {tools:[{type:'function'}]}
  assert.equal(toolModelSelection(selection,policy,tools).model,'claude-opus-5')
  assert.equal(toolModelSelection({...selection,fallback:''},policy,tools).model,'gpt-5.5')
  assert.strictEqual(toolModelSelection(selection,policy,{}),selection)
  assert.equal(selection.model,'gpt-6.1-sol')
  assert.throws(()=>toolModelSelection({...selection,fallback:''},{tiers:{}},tools),/备用文字模型/)
})

test('GPT 6.1 defaults to low reasoning to leave budget for employee deliverables', () => {
  const body = { model: 'gpt-6.1-sol', max_tokens: 4096 }
  assert.equal(toolCompatibleRequest(body).reasoning_effort, 'low')
  assert.equal(body.reasoning_effort, undefined)
  assert.equal(toolCompatibleRequest({...body,reasoning_effort:'high'}).reasoning_effort,'high')
})

test('Anthropic runtime requests select only configured Claude models; chat choices remain unchanged', async () => {
  const { protocolModelSelection } = await import('../apps/api/src/operations/gateway.mjs')
  const selected = { model: 'gpt-6.1-sol', fallback: 'gpt-5.5' }
  const policy = { tiers: { strong: 'claude-opus-5', cheap: 'gpt-5.5' } }
  const result = protocolModelSelection(selected, policy, '/api/anthropic/v1/messages')
  assert.equal(result.model, 'claude-opus-5')
  assert.equal(result.fallback, '')
  assert.strictEqual(protocolModelSelection(selected, policy, '/api/v1/chat/completions'), selected)
  assert.equal(selected.model, 'gpt-6.1-sol')
  assert.throws(() => protocolModelSelection(selected, { tiers: {} }, '/api/anthropic/v1/messages'), /Claude/)
})
