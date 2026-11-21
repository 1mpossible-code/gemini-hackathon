import type { IncomingMessage, ServerResponse } from 'node:http'

export function readBody(req: IncomingMessage, maxBytes = 5_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) {
        req.destroy()
        reject(new Error(`body exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function readJson<T = Record<string, unknown>>(
  req: IncomingMessage,
  maxBytes = 5_000_000,
): Promise<T> {
  const text = await readBody(req, maxBytes)
  try {
    return (text.trim() ? JSON.parse(text) : {}) as T
  } catch {
    throw new Error('invalid JSON')
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}
