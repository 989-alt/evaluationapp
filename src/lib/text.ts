// NEIS counts Korean as 3 bytes, ASCII as 1
export function neisBytes(str: string): number {
  let n = 0
  for (const ch of str) n += ch.charCodeAt(0) > 127 ? 3 : 1
  return n
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.。])\s+|(?<=[.。])$/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36)

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
