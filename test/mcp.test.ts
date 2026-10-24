import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HttpMcpClient } from '../src/mcp/client.ts'
import { RemoteMcpHost } from '../src/mcp/remote.ts'
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../src/config.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function sseResponse(id: number, result: unknown): Response {
  const body = `data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' },
  })
}

function jsonResponse(id: number, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' },
  })
}

test('HttpMcpClient connect and listTools over SSE/json', async () => {
  let calls = 0
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls++
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (body.method === 'initialize') {
      return jsonResponse(body.id, {
        protocolVersion: '2025-06-18',
        capabilities: {},
        serverInfo: { name: 'test', version: '1.0' },
      })
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 })
    }
    if (body.method === 'tools/list') {
      return jsonResponse(body.id, {
        tools: [
          { name: 'ping', description: 'ping', inputSchema: { type: 'object', properties: {} } },
        ],
      })
    }
    throw new Error('unexpected')
  }

  const client = await HttpMcpClient.connect({ name: 't', url: 'http://x/mcp', enabled: true }, { fetchImpl: fetchImpl as typeof fetch, timeoutMs: 1000 })
  const tools = await client.listTools()
  assert.equal(tools.length, 1)
  assert.equal(tools[0]!.name, 'ping')
  await client.close()
  assert.ok(calls >= 3)
})

test('HttpMcpClient callTool parses SSE response and isError', async () => {
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (body.method === 'initialize') {
      return jsonResponse(body.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 't', version: '1' } })
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 })
    }
    if (body.method === 'tools/call') {
      const res = {
        content: [{ type: 'text', text: 'ok-result' }],
        isError: false,
      }
      return sseResponse(body.id, res)
    }
    throw new Error('unexpected')
  }
  const client = await HttpMcpClient.connect({ name: 't', url: 'http://x/mcp', enabled: true }, { fetchImpl: fetchImpl as typeof fetch, timeoutMs: 1000 })
  const r = await client.callTool('ping', {})
  assert.equal(r.ok, true)
  assert.match(r.output, /ok-result/)
  await client.close()
})

test('RemoteMcpHost builds mcp_search_tools and mcp_call_tool', async () => {
  const fetchImpl = async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    if (body.method === 'initialize') {
      return jsonResponse(body.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 't', version: '1' } })
    }
    if (body.method === 'notifications/initialized') {
      return new Response('', { status: 202 })
    }
    if (body.method === 'tools/list') {
      return jsonResponse(body.id, {
        tools: [
          { name: 'getBalance', description: 'get balance of account', inputSchema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] } },
        ],
      })
    }
    if (body.method === 'tools/call') {
      return jsonResponse(body.id, { content: [{ type: 'text', text: '12345' }], isError: false })
    }
    throw new Error('unexpected')
  }
  const host = await RemoteMcpHost.start([{ name: 'tronscan', url: 'http://x/mcp', enabled: true, readOnly: true }], { fetchImpl: fetchImpl as typeof fetch, timeoutMs: 1000 })
  assert.equal(host.tools.length, 2)
  const names = host.tools.map((t) => t.def.name)
  assert.deepEqual(names, ['mcp_search_tools', 'mcp_call_tool'])
  const search = host.tools[0]!
  const res = await search.run({ query: 'balance' }, { cwd: '/tmp', signal: new AbortController().signal, todos: { list: () => [], write: () => [], nextId: () => '1' }, config: () => DEFAULT_CONFIG } as any)
  assert.equal(res.ok, true)
  assert.match(res.output, /getBalance/)
  const call = host.tools[1]!
  const callRes = await call.run({ server: 'tronscan', tool: 'getBalance', arguments: { address: 'TXYZ' } }, { cwd: '/tmp', signal: new AbortController().signal, todos: { list: () => [], write: () => [], nextId: () => '1' }, config: () => DEFAULT_CONFIG } as any)
  assert.equal(callRes.ok, true)
  assert.match(callRes.output, /12345/)
  await host.close()
})

test('config defaults include tronscan mcp', () => {
  const cfg = DEFAULT_CONFIG
  assert.ok(cfg.mcp)
  assert.ok(cfg.mcp.servers.some((s) => s.name === 'tronscan' && s.enabled === true))
})
