const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...init.headers },
  })
}

export async function readJson<T>(request: Request, maxBytes = 64 * 1_024): Promise<T> {
  const contentType = request.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new Response('JSON body required', { status: 415 })
  }
  const declaredLength = Number(request.headers.get('content-length') ?? 0)
  if (declaredLength > maxBytes) throw new Response('Request body too large', { status: 413 })
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Response('Request body too large', { status: 413 })
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Response('Invalid JSON', { status: 400 })
  }
}
