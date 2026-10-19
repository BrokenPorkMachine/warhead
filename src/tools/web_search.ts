/** web_search — bounded, provider-free web research.
 *
 * Uses DuckDuckGo's public HTML endpoint so Warhead stays dependency-free. The
 * endpoint can be replaced with WARHEAD_SEARCH_URL for a compatible search
 * service or a local proxy. Results are deliberately short and link-focused;
 * the model should fetch pages with its normal shell/browser workflow when it
 * needs primary-source detail.
 */
import type { Tool, ToolOutcome } from '../types.ts'
import { ArgError, optInt, reqString } from './args.ts'

const MAX_RESULTS = 8
const MAX_QUERY = 300

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim()
}

export const webSearch: Tool = {
  mutates: false,
  def: {
    name: 'web_search',
    description: 'Search the web and return a small set of titled links and snippets. Use for current or niche information; treat results as leads and prefer primary sources. Network access may require approval.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Focused search query' },
        max_results: { type: 'integer', description: `Maximum results, 1-${MAX_RESULTS}` },
      },
      required: ['query'],
    },
  },
  async run(args): Promise<ToolOutcome> {
    try {
      const query = reqString(args, 'query').slice(0, MAX_QUERY)
      const count = Math.min(MAX_RESULTS, Math.max(1, optInt(args, 'max_results', 1) ?? 5))
      const base = process.env['WARHEAD_SEARCH_URL'] ?? 'https://html.duckduckgo.com/html/'
      const url = `${base}${base.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`
      const res = await fetch(url, {
        headers: { 'user-agent': 'warhead-web-search/1.0' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) return { ok: false, output: '', error: `search returned HTTP ${res.status}` }
      const html = await res.text()
      const rows: string[] = []
      const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
      let match: RegExpExecArray | null
      while (rows.length < count && (match = re.exec(html))) {
        rows.push(`${rows.length + 1}. ${stripHtml(match[2] ?? '')}\n   ${match[1] ?? ''}\n   ${stripHtml(match[3] ?? '')}`)
      }
      return { ok: true, output: rows.length ? `Search results for: ${query}\n\n${rows.join('\n\n')}` : `No results found for: ${query}` }
    } catch (err) {
      return { ok: false, output: '', error: err instanceof ArgError ? err.message : String(err) }
    }
  },
}
