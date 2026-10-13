export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(bin)
}

/** Text extraction for providers without native PDF input (OpenAI). Lazy-loads pdf.js. */
export async function pdfToText(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise
  const pages: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    // group by line (y position) to keep table rows together
    const lines = new Map<number, Array<{ x: number; s: string }>>()
    for (const it of content.items as any[]) {
      if (!it.str) continue
      const y = Math.round(it.transform[5] / 4) * 4
      const arr = lines.get(y) ?? []
      arr.push({ x: it.transform[4], s: it.str })
      lines.set(y, arr)
    }
    const ordered = Array.from(lines.entries()).sort((a, b) => b[0] - a[0])
    pages.push(ordered.map(([, arr]) => arr.sort((a, b) => a.x - b.x).map((a) => a.s).join(' ')).join('\n'))
  }
  return pages.join('\n\n--- page ---\n\n')
}
