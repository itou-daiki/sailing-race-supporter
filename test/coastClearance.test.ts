import { describe, expect, it, vi } from 'vitest'
import { assessCoastClearance, sampleCoursePath } from '../src/coastClearance'

function demTile(value: 'e' | '0'): string {
  const row = Array.from({ length: 256 }, () => value).join(',')
  return Array.from({ length: 256 }, () => row).join('\n')
}

describe('coast clearance', () => {
  it('samples long course legs instead of checking marks only', () => {
    const points = sampleCoursePath([[131.52, 33.28], [131.52, 33.29]], 100)
    expect(points.length).toBeGreaterThan(10)
  })

  it('accepts a course surrounded by sea cells', async () => {
    const fetcher = vi.fn(async () => new Response(demTile('e'))) as unknown as typeof fetch
    await expect(assessCoastClearance([[131.522, 33.279]], 300, fetcher)).resolves.toEqual({
      status: 'safe',
      minimumMetres: 300,
    })
  })

  it('rejects a course point on land', async () => {
    const fetcher = vi.fn(async () => new Response(demTile('0'))) as unknown as typeof fetch
    const result = await assessCoastClearance([[131.522, 33.279]], 300, fetcher)
    expect(result.status).toBe('unsafe')
    if (result.status === 'unsafe') expect(result.minimumMetres).toBe(0)
  })

  it('does not claim safety when official elevation tiles are unavailable', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch
    await expect(assessCoastClearance([[131.522, 33.279]], 300, fetcher)).resolves.toEqual({ status: 'unavailable' })
  })
})
